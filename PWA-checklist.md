# PWA Completion Checklist

Use this checklist when turning the boilerplate in `apps/pwa` into a production
member-area PWA. Complete it after the product, funnel, and offer have been defined and
before production traffic is sent to the PWA.

This checklist is a launch gate. A checkbox is complete only when the implementation is
in the repository and the result has been verified in a production build or preview over
HTTPS. Record links, screenshots, test output, or a short decision beside any item whose
result is not obvious from code.

The intended data path is:

```text
PWA browser
  -> same-origin PWA API
  -> project Supabase database
  -> future authenticated export / API gate
  -> unified PMC analytics dashboard
```

The PWA must not send product analytics directly to PostHog or another third-party
analytics product. The project database is the source of truth; the future unified
dashboard consumes the stable internal event contract.

## Reference audit

The checklist incorporates reusable patterns found in the current boilerplate and the
local MemoriesReplay, ADHD Kiddo, Nocturnum, and NoYell projects. These projects are
references, not templates to copy wholesale.

| Reference | Pattern worth reusing | Do not copy blindly |
| --- | --- | --- |
| Current boilerplate | Serwist build, offline fallback, auth and entitlement shell, first-party analytics, payment recovery | Placeholder brand, content, products, and audio cache |
| MemoriesReplay | Separate `any` and `maskable` icons, production-only worker registration, stale-worker cleanup, multi-device push cleanup | Its product-specific cache and notification payloads |
| ADHD Kiddo | Locale-aware manifest, Android install prompt, iOS instructions, safe storage access, sequencing install and notification prompts | PostHog, Clarity, pixels, or other third-party product tracking |
| Nocturnum | Locale-aware start route, install onboarding, safe-area layout, notification deep links, conservative cache exclusions | Hard-coded app-shell routes and product copy |
| NoYell | Authenticated member shell, entitlement-expiry handling, paid-user recovery | It does not provide the complete manifest/service-worker/install layer |

## 1. Decide the product PWA contract

- [ ] Record the production PWA origin, preview origin, and local origin.
- [ ] Choose the first authenticated landing route and the login fallback route.
- [ ] Decide whether `start_url` is global or locale-specific.
- [ ] Choose the supported locales, default locale, and RTL requirements.
- [ ] Choose the install display mode, orientation policy, theme color, and background
  color.
- [ ] Decide which product content, if any, must work offline. Do not assume all private
  content should be cached.
- [ ] Decide whether push notifications are required. If not, mark section 10 `N/A` and
  do not show notification permission UI.
- [ ] List the subscription and one-time products available inside the member area.
- [ ] Define the user states the PWA must handle: new paid user, returning user, grace
  period, expired/revoked access, no entitlement, payment return, and offline user.
- [ ] Name an owner for product sign-off, payment sign-off, privacy sign-off, and PWA QA.

## 2. Replace every boilerplate product seam

- [ ] Update `packages/shared/src/boilerplate-brand.ts` with the real name, short name,
  tagline, description, URLs, support email, and social metadata.
- [ ] Replace `apps/pwa/src/components/BrandMark.tsx` with the real logo while preserving
  its accessible label and responsive behavior.
- [ ] Replace every file in `apps/pwa/public/images/favicon/` with final brand assets;
  keep the existing filenames unless all references are updated together.
- [ ] Replace `apps/pwa/public/og-image.png` with a final 1200 x 630 image.
- [ ] Replace the placeholder dashboard tabs in
  `apps/pwa/src/app/[locale]/(app)/dashboard/_components/tabs/` with real product
  surfaces.
- [ ] Restyle the shared shell through
  `apps/pwa/src/app/[locale]/(app)/dashboard/_components/theme.css`; do not scatter
  duplicate brand tokens through individual screens.
- [ ] Replace the first-run onboarding artwork, copy, completion condition, and
  provisioning behavior.
- [ ] Update `apps/pwa/src/lib/pwa-products.ts` and verify every in-app product code,
  access level, price display, entitlement grant, and purchase-success state.
- [ ] Replace all `pwa` and `billing` copy in `packages/i18n/messages/<locale>/`.
- [ ] Resolve every PWA `TODO(new product)` and every visible `Placeholder` before
  launch.

Useful audit:

```bash
rg -n "TODO\(new product\)|Placeholder|Acme" apps/pwa packages/i18n packages/shared
```

## 3. Configure the environment and database

- [ ] Copy `apps/pwa/.env.example` to `apps/pwa/.env.local` for local development; do
  not commit the populated file.
- [ ] Set `NEXT_PUBLIC_PWA_URL` and `NEXT_PUBLIC_FUNNEL_URL` to the exact origins for
  each Vercel environment.
- [ ] Point `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the
  server-only `SUPABASE_SERVICE_ROLE_KEY` at the same Supabase project.
- [ ] Generate fresh `INTERNAL_API_SECRET`, `CRON_SECRET`, and payment secrets for the
  new project. Never reuse another product's secrets.
- [ ] Set one permanent lowercase `ANALYTICS_PROJECT_KEY`. Use the same value in the
  funnel, PWA, webhook, export job, and future unified dashboard mapping.
- [ ] Apply the baseline and all later migrations, including
  `20260909140518_unified_internal_analytics.sql` and any product migrations. Do not edit
  an already-deployed baseline migration.
- [ ] Decide whether the advisor module belongs in the new product before the first
  database deployment. Keep and apply `20260909140519_advisor_module.sql` in sequence,
  or remove it before any migration is deployed; never skip a file inside an applied
  migration chain. When the module is not in scope, keep its UI and APIs disabled.
- [ ] Regenerate `packages/shared/src/types/database.ts` after schema changes.
- [ ] Run the Supabase SQL tests, including `supabase/tests/unified_schema.sql`.
- [ ] Verify Row Level Security with two different users. A user must never read or
  modify another user's preferences, entitlements, conversations, messages, or files.
- [ ] Confirm `service_role` is used only by server code and never appears in a browser
  bundle, response, log, or `NEXT_PUBLIC_*` variable.

## 4. Complete authentication, provisioning, and access control

- [ ] Verify the funnel-to-PWA handoff exchanges the one-time token for a session and
  removes sensitive token material from the visible URL.
- [ ] Verify direct visits to protected routes go to the locale-correct login page and
  return to the intended route after authentication.
- [ ] Test OTP request, OTP verification, logout, expired session refresh, and login on a
  second device.
- [ ] Keep development login shortcuts disabled in production.
- [ ] Implement the product work in
  `apps/pwa/src/app/api/internal/provision-member-area/route.ts`. Make it authenticated,
  idempotent, and safe to retry after a timeout.
- [ ] Treat server-resolved entitlements as the access-control source of truth. Client
  state may improve the UI but must not grant paid access.
- [ ] Test active, grace-period, expired, and revoked entitlement states.
- [ ] Test the paid-user recovery path when payment succeeded but profile or member-area
  provisioning was delayed.
- [ ] Verify the locale, display name, notification choice, and timezone round-trip
  through `/api/user-prefs` and survive sign-out/sign-in.
- [ ] Confirm all auth, provisioning, preference, payment, and internal APIs reject
  unauthenticated or malformed requests with safe responses.

## 5. Finalize the web app manifest and OS metadata

- [ ] Review `apps/pwa/src/app/manifest.ts` and set final `name`, `short_name`,
  `description`, stable `id`, `start_url`, `scope`, `display`, `orientation`, `lang`,
  categories, theme color, and background color.
- [ ] Keep the stable manifest `id` and `start_url` free of campaign or authentication
  query parameters.
- [ ] Make `start_url` land on a valid page for signed-in, signed-out, expired, and
  first-run users.
- [ ] If the installed name, language, direction, or start route varies by locale,
  implement a locale-aware manifest endpoint and verify its cache behavior. Otherwise,
  document the single-language manifest decision.
- [ ] Provide real 192 x 192 and 512 x 512 PNG icons with `purpose: "any"`.
- [ ] Provide a separately tested 512 x 512 maskable icon with adequate safe-zone
  padding. Do not relabel an edge-to-edge icon as maskable without checking the crop.
- [ ] Provide an opaque 180 x 180 Apple touch icon plus 16 x 16, 32 x 32, and `.ico`
  browser icons.
- [ ] Ensure every icon URL returns `200`, the declared MIME type, and the declared
  dimensions.
- [ ] Verify the manifest `background_color` matches the first painted app surface so
  launch does not flash a different color.
- [ ] Review `apps/pwa/src/app/[locale]/layout.tsx`: title, description, manifest link,
  icon links, Apple web-app metadata, Open Graph data, and `formatDetection` must use the
  new brand.
- [ ] Set `viewportFit: "cover"` when the app uses safe-area insets, and verify the
  theme/status-bar color on both light and dark device chrome.
- [ ] Keep `html lang` and `dir` aligned with the resolved locale, including mapped
  BCP-47 codes and RTL locales.

## 6. Finalize the service worker and offline behavior

- [ ] Keep `@serwist/next` configured in `apps/pwa/next.config.ts` with
  `src/sw.ts -> public/sw.js` and disabled during normal development.
- [ ] Confirm a production build emits `/sw.js` and any required worker chunks.
- [ ] Review every rule in `apps/pwa/src/sw.ts`; remove the example audio cache if the
  product has no audio.
- [ ] Add runtime caches only for resources that have a clear offline requirement,
  bounded entry count, bounded age, and safe invalidation strategy.
- [ ] Never cache auth responses, API responses, admin/support pages, payment pages,
  checkout/3DS traffic, signed URLs, or personalized HTML as public shared content.
- [ ] Preserve HTTP range behavior for cached audio/video. If byte-range playback is not
  proven, let the browser fetch the media normally.
- [ ] Keep third-party requests out of custom cache rules unless their CORS behavior and
  data-retention impact have been explicitly reviewed.
- [ ] Verify `apps/pwa/src/app/[locale]/~offline/page.tsx` is fully local, branded,
  translated, accessible, and useful without network access.
- [ ] Test a cold offline navigation and a repeat offline navigation. The app must show
  the offline fallback, not a browser error or stale private data from another account.
- [ ] Choose and test an update policy: automatic activation or a user-visible refresh
  prompt. An update must not discard unsaved user work or create an infinite reload loop.
- [ ] Test upgrading from the previous deployed worker and cache set. Add a one-time
  worker/cache migration when old registrations can interfere with the new App Router
  build.
- [ ] Verify service-worker failure is non-fatal: online auth, content, and payments must
  still work when registration is unavailable.

## 7. Implement the install experience

- [ ] Detect installed mode using `display-mode: standalone` plus the iOS standalone
  flag. Treat detection as presentation/analytics state, never as authorization.
- [ ] Capture `beforeinstallprompt` on supported Chromium browsers and trigger it only
  from a clear user action.
- [ ] Provide translated iPhone/iPad Safari instructions using Share -> Add to Home
  Screen; do not claim a native prompt exists on iOS.
- [ ] Hide install prompts when already installed, unsupported, or recently dismissed.
- [ ] Store dismissals defensively: unavailable `localStorage` or `sessionStorage` must
  not white-screen the PWA.
- [ ] Choose a respectful prompt time based on demonstrated value or onboarding
  completion; do not cover login, payment, or another modal.
- [ ] Handle accepted, dismissed, and unavailable prompt states without blocking the
  member journey.
- [ ] Record `installed_pwa` through internal analytics on `appinstalled` and on the
  first authenticated standalone launch for platforms that do not fire that event.
- [ ] Deduplicate the install event in the database as well as on the device.
- [ ] Open the installed app from the home screen and verify icon, name, launch colors,
  route, locale, session, standalone chrome, and back navigation.

## 8. Complete the member-area experience

- [ ] Replace all placeholder content with the product's primary daily/repeat-use value.
- [ ] Make first-run onboarding skippable/replayable as required and persist completion
  in the correct place. Device storage alone is not sufficient for cross-device state
  when completion affects product access.
- [ ] Verify bottom navigation, menus, drawers, paywalls, and dialogs support keyboard
  focus, screen readers, Escape/back behavior, and return focus correctly.
- [ ] Test `100dvh`, keyboard resize, rotation policy, and all four safe-area insets on
  notched iOS and Android devices.
- [ ] Ensure tap targets, text sizing, contrast, reduced motion, loading states, empty
  states, errors, and retry actions are usable on a small phone.
- [ ] Preserve critical user work across refresh, route changes, temporary network loss,
  and duplicate taps.
- [ ] Make offline-unavailable actions visibly disabled or recoverable; never leave an
  indefinite spinner.
- [ ] Verify deep links opened from email or notifications restore auth and land on the
  intended locale-aware screen.
- [ ] Verify profile changes, logout, account support, legal links, and subscription
  management from installed mode.

## 9. Use internal analytics only

- [ ] Keep all PWA product events on the same-origin `/api/analytics/events` path, which
  binds the authenticated user server-side and writes to `analytics_events`.
- [ ] Keep `analytics_events` append-only and inaccessible to `anon` and
  `authenticated`; browser code must not write to it directly with Supabase.
- [ ] Use lowercase `snake_case` event names and version the contract rather than
  silently changing the meaning of an existing event.
- [ ] Emit at least `first_login`, `app_opened`, `page_view`, and `installed_pwa`.
- [ ] Add product-specific events such as `cta_clicked`, `paywall_opened`,
  `content_started`, or `content_completed` with a documented `target`/content key.
- [ ] Emit advisor events only when enabled: `advisor_conversation_started` and
  `advisor_message_sent`.
- [ ] Keep canonical revenue events on trusted payment/webhook code. Do not derive
  booked revenue only from a client success screen.
- [ ] Give retryable or unique business events a stable `event_key` so the database and
  unified dashboard can deduplicate them.
- [ ] Include `project_key`, deployment environment, source app, event time, schema
  version, authenticated user/session identifiers where allowed, and minimal properties.
- [ ] Never put email addresses, access tokens, full URLs/query strings, advisor message
  text, uploaded file paths, journal/content text, or other sensitive payloads in event
  properties.
- [ ] Make analytics failure non-blocking. Login, navigation, content, and payment flows
  must continue when event ingestion fails.
- [ ] Verify preview/development events are labeled with their real environment and do
  not pollute production reporting.
- [ ] Validate the export contract in `docs/internal-analytics.md`: export incrementally
  in `(created_at, id)` order, retain `occurred_at`, maintain a per-project cursor, and
  deduplicate on `(project_key, deployment_environment, source_app, event_key)`.
- [ ] Do not give the central dashboard a browser/service-role credential. Use a
  server-to-server exporter or narrowly scoped authenticated API when dashboard work
  begins.
- [ ] Confirm the PWA loads no PostHog, Clarity, Google Analytics, Vercel Analytics,
  Speed Insights, or copied session-recording SDK. Do not copy tracking setup from the
  reference apps.

Required audit:

```bash
rg -n -i "posthog|clarity|google-analytics|gtag\(|@vercel/analytics|@vercel/speed-insights" \
  apps/pwa package.json apps/pwa/package.json
```

The expected result is no PWA runtime integration. If a historical name appears only in
a migration comment or removal note, record why it is harmless.

## 10. Push notifications (conditional)

Complete this section only when notifications are part of the approved product scope.
The `notifications_enabled` preference by itself does not implement Web Push.

- [ ] Generate unique VAPID keys for the product and configure
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, server-only `VAPID_PRIVATE_KEY`, and an owned
  `VAPID_SUBJECT` in the correct environments.
- [ ] Add a `push_subscriptions` table that supports multiple devices per user, unique
  endpoints, timestamps, optional expiration, and owner-safe access policies.
- [ ] Request notification permission only after a user gesture and after explaining the
  specific value. Do not request it at page load.
- [ ] Sequence install and notification prompts so they never compete.
- [ ] On iOS, explain that Web Push requires an installed home-screen web app on
  supported versions; provide a useful fallback when unavailable.
- [ ] Reuse an existing browser subscription when possible and upsert it through an
  authenticated, validated API.
- [ ] Keep the database subscription and `user_prefs.notifications_enabled` consistent
  on enable, disable, permission revocation, logout, and account deletion.
- [ ] Implement unsubscribe from both the Push Manager and the server database.
- [ ] Remove expired endpoints after push-provider `404` or `410` responses.
- [ ] Localize title/body/action copy and schedule against the saved IANA timezone.
- [ ] Make notification jobs idempotent and observable so retries cannot send duplicate
  messages.
- [ ] Handle notification clicks by focusing an existing same-origin client or opening a
  validated same-origin, locale-aware deep link.
- [ ] Never accept an arbitrary external notification-click URL.
- [ ] Test granted, default, denied, later-revoked, unsupported, multiple-device, and
  expired-subscription states.
- [ ] Confirm notification failure never blocks the underlying product action.

## 11. Advisor module (conditional)

- [ ] Confirm `advisor_conversations`, `advisor_messages`, and
  `advisor_message_attachments` are present and match generated database types.
- [ ] Enforce conversation ownership in every read/write API and in RLS.
- [ ] Populate title from the first user message and preview from the first advisor
  response, while keeping a separate latest-message preview and timestamp.
- [ ] Validate the `user` / `advisor` role server-side and use idempotent client message
  IDs to prevent duplicate sends.
- [ ] Store image bytes in a private Storage bucket. Store only bucket/object references
  in attachments and enforce conversation ownership in Storage policies.
- [ ] Define attachment type, size, malware/content handling, retention, deletion, and
  signed-URL expiry rules.
- [ ] Show send, streaming/processing, delivered, failed, retry, and offline states.
- [ ] Exclude message bodies and attachment paths from analytics and application logs.
- [ ] Test conversation rename/archive, pagination, multiple devices, retries, and full
  user-data deletion.

## 12. Complete in-app payments and entitlement recovery

- [ ] Configure the PWA's Solidgate sandbox keys and keep production keys only in the
  production environment.
- [ ] Seed and verify the catalog, then commit the non-secret catalog ID mapping.
- [ ] Verify product codes in `pwa-products.ts` map to the intended entitlement access
  level and payment environment.
- [ ] Test purchase creation, Solidgate form initialization, double-click protection,
  decline, retry, cancel, 3DS success/failure, refresh, and delayed webhook fulfillment.
- [ ] Test `SolidgatePurchaseReturn`, card update, grace-period banner, subscription end,
  and restore/recovery paths from installed mode.
- [ ] Keep checkout online-only unless the payment provider explicitly supports another
  model; show a clear offline message instead of queuing payment submissions.
- [ ] Add the Apple Pay domain association file for the exact PWA domain and verify it is
  served as `text/plain`.
- [ ] Confirm CSP/frame rules permit the approved Solidgate and 3DS hosts without opening
  framing or script access broadly.
- [ ] Verify the bank-statement product name, amount, currency, trial, renewal interval,
  and entitlement duration in both sandbox and live catalogs.
- [ ] Confirm client confirmation events are informational and webhook/server records
  remain authoritative for revenue and access.

## 13. Security, privacy, and platform behavior

- [ ] Serve production and preview PWAs over HTTPS with no mixed content.
- [ ] Add restrictive security headers compatible with Supabase, Solidgate, required
  media, and the service worker; remove origins belonging to reference products.
- [ ] Keep protected member, admin, support, API, and payment responses `no-store` where
  appropriate and exclude them from search indexing.
- [ ] Verify `robots.ts` and metadata keep the private member area out of indexes while
  public funnel/legal pages follow their own SEO decision.
- [ ] Validate all redirect/deep-link destinations against allowed same-origin routes.
- [ ] Rate-limit sensitive authentication, provisioning, advisor, payment, upload, and
  analytics endpoints as appropriate.
- [ ] Ensure logs redact tokens, authorization headers, payment data, email addresses,
  message content, signed URLs, and service credentials.
- [ ] Update privacy, cookies, subscription, refund, and support content for installed
  app behavior, internal analytics, notifications, file storage, retention, and deletion.
- [ ] Test account deletion/export requirements across auth data, preferences,
  entitlements, analytics policy, advisor data, attachments, and push subscriptions.
- [ ] Confirm the PWA does not depend on third-party analytics scripts, cookies, or ad
  blockers for any functional path.

## 14. Verification matrix

### Automated checks

- [ ] `npm run test --workspace=@repo/pwa`
- [ ] `npm run lint --workspace=@repo/pwa`
- [ ] `npm run build --workspace=@repo/pwa`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] Database migration and SQL tests pass against a clean local database.
- [ ] No PWA route, TypeScript, lint, or test error is being hidden by an ignore flag.

### Production-build checks

Run the PWA as a production build because the boilerplate intentionally disables the
service worker in normal development:

```bash
npm run build --workspace=@repo/pwa
npm run start --workspace=@repo/pwa -- -p 3206
```

- [ ] `/manifest.webmanifest`, `/sw.js`, all icons, and `/~offline` return the expected
  status, content type, and cache headers.
- [ ] Browser developer tools show a valid manifest, active worker, correct scope, no
  worker/manifest errors, and no third-party analytics requests.
- [ ] A clean profile can install the PWA; an already-installed profile is not prompted
  again.
- [ ] Clear site data and repeat the full install, login, offline, and update flow.

### Device/browser matrix

- [ ] Current iPhone Safari: browser mode and installed home-screen mode.
- [ ] Current Android Chrome: browser mode, native install prompt, and installed mode.
- [ ] Desktop Chrome or Edge: install, standalone window, deep link, and update.
- [ ] Desktop/mobile Safari: online behavior remains correct even where an API differs.
- [ ] At least one older/low-memory phone and one slow-network profile.
- [ ] Light/dark OS chrome, portrait/landscape policy, notched screen, keyboard open, and
  reduced-motion preference.

### End-to-end journeys

- [ ] New paid user: funnel purchase -> account provisioning -> PWA session -> first-run
  onboarding -> product content.
- [ ] Returning paid user: home-screen launch -> restored session -> correct content.
- [ ] Signed-out deep link: login -> return to requested safe route.
- [ ] Expired/revoked user: correct blocked state and recovery action.
- [ ] Grace-period user: warning -> card update -> restored access.
- [ ] In-app purchase: paywall -> 3DS if required -> webhook -> entitlement -> UI update.
- [ ] Offline launch/navigation: correct cached content or translated fallback, with no
  cross-user leakage.
- [ ] Worker upgrade: old deployed version -> new version without loop, blank screen, or
  stale private response.
- [ ] Internal analytics: each canonical event arrives once with correct project,
  environment, source, user/session, event key, and safe properties.
- [ ] Analytics outage: the same journeys still complete successfully.
- [ ] Push lifecycle, when enabled: opt in -> receive -> click/deep link -> opt out -> no
  further delivery.

## 15. Deployment and release

- [ ] Create/link the separate PWA deployment and verify its monorepo root, build
  command, output, Node version, and environment scopes.
- [ ] Add the final PWA domain, DNS, Supabase Auth redirect URLs, CORS/allowlists,
  Solidgate callbacks, webhook fulfillment target, email links, and Apple Pay domain.
- [ ] Confirm every `NEXT_PUBLIC_*` change was followed by a rebuild; those values are
  embedded in the browser bundle.
- [ ] Apply database migrations before deploying code that depends on them.
- [ ] Deploy a preview and complete the entire verification matrix over HTTPS.
- [ ] Deploy production, then repeat manifest, worker, login, entitlement, payment,
  offline, install, and internal-analytics smoke tests on the real domain.
- [ ] Record the deployed commit, database migration version, worker version/update
  policy, catalog verification, test output, and sign-off evidence.
- [ ] Prepare a rollback that keeps database migrations and older clients compatible.
- [ ] Verify the future unified-dashboard export can be added without changing browser
  event calls or exposing the project database to the public internet.

## Definition of done

The PWA step is complete only when all applicable statements below are true:

- [ ] There are no visible boilerplate names, assets, products, placeholder screens, or
  unresolved PWA product TODOs.
- [ ] The manifest, icons, metadata, HTTPS origin, and service worker produce an
  installable app on the supported platforms.
- [ ] Online, offline, first-install, repeat-launch, and worker-update behavior have been
  tested on real iOS and Android devices.
- [ ] Authentication, provisioning, preferences, entitlements, in-app payments, and
  recovery states are enforced server-side and pass end-to-end tests.
- [ ] The PWA uses only the internal `analytics_events` pipeline for product analytics;
  no PostHog or other third-party product/session analytics runtime is present.
- [ ] Events are safe, idempotent where required, environment-labelled, and ready for the
  future unified dashboard export contract.
- [ ] Push and advisor sections are either fully completed and verified or explicitly
  recorded as `N/A` with their UI disabled.
- [ ] Security, privacy, accessibility, localization, performance, and deployment checks
  are signed off with evidence.

## Release evidence

| Item | Result / link / owner |
| --- | --- |
| Preview URL | |
| Production URL | |
| Tested commit | |
| Database migration version | |
| Manifest and icon inspection | |
| iOS install test | |
| Android install test | |
| Offline/update test | |
| Auth and entitlement E2E | |
| Payment/3DS E2E | |
| Internal analytics query/export sample | |
| Third-party analytics audit | |
| Push decision/test | |
| Advisor decision/test | |
| Privacy/security sign-off | |
| Final product owner sign-off | |
