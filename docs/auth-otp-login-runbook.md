# Auth — OTP sign-in runbook

How member-area sign-in works, and what you **must** configure in a hosted Supabase
project for the 6-digit OTP to actually work in production.

---

## 1. The two sign-in paths

**A. Just-purchased buyer → signed into the PWA automatically, no code.**

The last funnel step (`oto/8`, the "Open app" button) pushes to the funnel `/dashboard`.
That page takes the signed-in funnel user, generates a one-time magic-link token
(`generateLink`) and redirects to `{PWA}/dashboard?auth_token=…&locale=…`. The PWA proxy
(`apps/pwa/src/proxy.ts`, the `auth_token` relay) exchanges the token for a session.

**No email is sent on this path** — the token is verified server-side directly.

**B. Returning user → `/login` → 6-digit OTP.**

`apps/pwa/src/app/[locale]/login/_components/LoginShell.tsx`
→ `POST /api/auth/request-otp` (`signInWithOtp`, `shouldCreateUser: false`)
→ Supabase emails a code
→ user enters 6 digits
→ `POST /api/auth/verify-otp` → session + redirect to `/dashboard`.

Both apps share the login UI and the rate limiter from `packages/shared/src/auth/`.

### Brute-force protection

Backed by the `otp_attempts` table: soft-lock after **5 failures in 15 minutes**,
hard-lock after **10 failures in 60 minutes**. Fails **open** on a database error, so a
DB blip cannot lock every user out.

`request-otp` returns a generic 200 with no email for an unknown address — that is
deliberate account-existence protection, not a bug.

---

## 2. Required hosted-Supabase configuration

`supabase/config.toml` applies to the **local** stack only. A hosted project is configured
separately through the Dashboard. All four of these are required before launch:

1. **Magic Link email template** (Authentication → Emails → Magic Link)

   The body must render **`{{ .Token }}`** (the 6-digit code), not
   `{{ .ConfirmationURL }}`. Paste in the contents of
   [`supabase/templates/otp-email.html`](../supabase/templates/otp-email.html).

   > Without this, `signInWithOtp` sends a *link* instead of a *code* and `/login`
   > silently stops working.

   Set the subject to something like `Your <Product> sign-in code`.

2. **OTP settings** (Authentication → Providers → Email)
   - `Email OTP length` = **6**
   - `Email OTP expiry` = **3600** seconds (60 min) — must match the email copy
   - `Enable email signups` = **ON** (so `createUser` during provisioning works)

3. **Custom SMTP** (Authentication → Emails → SMTP Settings)

   Configure your own SMTP (e.g. Resend). Without it you are on Supabase's built-in
   limits (roughly 3–4 emails/hour) and OTP codes simply will not reach users.

4. **Rate limits** (Authentication → Rate Limits)

   Leave "Token verifications" and "Emails sent" at safe defaults. App-level lockout
   already exists via `otp_attempts`; the Supabase-level limit is a second layer.

> The OTP path needs **nothing** added to `Site URL` / `Redirect URLs`: `verify-otp` uses
> a `token`, not a URL, and the purchase handoff uses a `token_hash`. The redirect
> allow-list does not gate either flow.

---

## 3. Environment variables

- **PWA production:** leave `NEXT_PUBLIC_ENABLE_DEV_LOGIN` **unset**. A production build
  hard-disables the dev bypass anyway (`NODE_ENV=production`), but do not leave it on
  anywhere.
- **Local development:** `/login` shows the **real** OTP flow by default and works against
  a local Supabase + its mail viewer. For a one-click dev login, put
  `NEXT_PUBLIC_ENABLE_DEV_LOGIN=true` in `apps/pwa/.env.local` and restart the dev server.

---

## 4. Local verification

Requires Docker and `supabase start`.

```bash
supabase stop && supabase start     # re-reads config.toml, including the email template
npm run dev:pwa                     # PWA on :3206

# 1) Request a code
curl -s -X POST http://localhost:3206/api/auth/request-otp \
  -H 'content-type: application/json' -d '{"email":"buyer@example.com"}'

# 2) Read the code in the local mail viewer
open http://127.0.0.1:55424         # confirm the port with `supabase status`

# 3) Verify — expect { ok:true, redirectTo:'/dashboard' } plus a set-cookie
curl -si -X POST http://localhost:3206/api/auth/verify-otp \
  -H 'content-type: application/json' -d '{"email":"buyer@example.com","token":"123456"}'

# 4) Rate limit — 5 wrong codes inside 15 min returns 429 "Too many failed attempts"
```

`buyer@example.com` must already exist as an auth user (i.e. have "purchased"), because
`shouldCreateUser` is `false`. A brand-new address gets the generic 200 with no email.

---

## 5. Keep the expiry copy in sync

The OTP expiry is configured in **three** places that must agree:

| Where | What |
|---|---|
| Supabase Dashboard | `Email OTP expiry` (seconds) |
| `supabase/templates/otp-email.html` | the "expires in N minutes" line |
| `packages/i18n/messages/en/pwa.json` | `login.otpHelper` |

The upstream product shipped with these disagreeing (UI said 10 minutes, the real expiry
was 60). Check all three when you change one.
