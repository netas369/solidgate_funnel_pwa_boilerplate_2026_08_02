# Cron Jobs

Centralised reference for all scheduled jobs in the PWA. Add new entries at the top
of the **Active Jobs** table when you create them, and fill in the matching detailed
section below.

Vercel Cron is configured in [`apps/pwa/vercel.json`](../apps/pwa/vercel.json). All
job handlers live under [`apps/pwa/src/app/api/cron/`](../apps/pwa/src/app/api/cron/).

## How cron auth works

Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` to the configured path.
Each handler accepts that header for production, **and** also `x-internal-secret:
${INTERNAL_API_SECRET}` for local/manual triggers. Unauthorized requests get 401.

> ⚠️ **Before production deploy:** the local `.env.local` ships with the placeholder
> `INTERNAL_API_SECRET=dev-local-internal-secret-change-me`. That is fine for
> localhost (no inbound internet), but **must be replaced** with a strong random
> value on Vercel:
>
> ```bash
> openssl rand -hex 32                      # generate
> vercel env add INTERNAL_API_SECRET production   # paste
> ```
>
> `CRON_SECRET` is auto-managed by Vercel when `vercel.json` declares `crons[]`
>  -  no manual setup required.

For local manual triggers, use **one of**:

```bash
# Option A: inline-extract the secret from .env.local (no shell pollution)
SECRET=$(grep "^INTERNAL_API_SECRET=" apps/pwa/.env.local | cut -d= -f2-) \
  curl -X POST -H "x-internal-secret: $SECRET" \
  "http://localhost:3206/api/cron/<job>?force=1"

# Option B: load all .env.local vars into your shell first
export $(grep -v '^#' apps/pwa/.env.local | xargs)
curl -X POST -H "x-internal-secret: $INTERNAL_API_SECRET" \
  "http://localhost:3206/api/cron/<job>?force=1"
```

**Heads up:** running `curl ... -H "x-internal-secret: $INTERNAL_API_SECRET"`
straight without one of the above gives a 401  -  your shell doesn't auto-read
`.env.local`; only Next.js does. Empty header → unauthorized.

## Gotcha: PostgREST schema cache after migration

After applying a Supabase migration that adds a new table (`supabase migration up`),
PostgREST will keep its **schema cache stale** until reloaded. Symptom:

```
[loadDailyFocus] read failed {
  code: 'PGRST205',
  message: "Could not find the table 'public.<your_table>' in the schema cache"
}
```

Fix in one line:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 55422 -U postgres -d postgres \
  -c "NOTIFY pgrst, 'reload schema';"
```

Or restart the local Supabase stack (`supabase stop && supabase start`).

Always run this **once after each new migration** that adds tables/columns,
or PostgREST will return 404 to your queries even though the table exists.

For production manual triggers (from your laptop with Vercel CLI):
```bash
curl -X POST -H "Authorization: Bearer $(vercel env pull --yes && grep CRON_SECRET .env.local | cut -d= -f2)" \
  "https://<deployment>.vercel.app/api/cron/<job>"
```

## Schedule format

Vercel uses standard 5-field cron expressions in **UTC**:
`minute hour day-of-month month day-of-week`. Examples:
- `5 0 * * *`  -  every day at 00:05 UTC
- `0 */6 * * *`  -  every 6 hours on the hour
- `0 9 * * 1`  -  every Monday at 09:00 UTC

## Active Jobs

| Job | Path | Schedule (UTC) | Purpose | Est. cost/mo |
|---|---|---|---|---|
| Daily Content | `/api/cron/daily-content` | `10 0 * * *` (00:10 daily) | Generate Horoscope/Remember/Ritual/Practice (4 texts in one call) per (sun_sign × locale) for today + tomorrow | ~$5–7 |
| Daily Focus | `/api/cron/daily-focus` | `5 0 * * *` (00:05 daily) | Generate "Focus of the Day" filter phrase per (sun_sign × locale) for today + tomorrow | ~$1.65 |
| Moon Forecast | `/api/cron/moon-forecast` | `0 1 * * 0` (Sunday 01:00 weekly) | Pre-generate Section IV paragraph per (moon_phase × moon_sign × locale). 1344 combos total, idempotent  -  fully cached after first run. | ~$0 (one-time ~$1.20) |

---

## Job: Moon Forecast

**Path:** `/api/cron/moon-forecast` ([source](../apps/pwa/src/app/api/cron/moon-forecast/route.ts))
**Schedule:** `0 1 * * 0`  -  every Sunday at 01:00 UTC (safety backfill only)
**Status:** ✅ Live since 2026-04-28

### What it does

Generates one paragraph per `(moon_phase × moon_sign × locale)` combo for
HomePage Section IV (Today's Moon Forecast). The paragraph integrates the
phase's cycle direction with the sign's emotional flavour, validates the
state, and offers a practical regulation.

Unlike Daily Focus / Daily Content, this content is **independent of date and
sun_sign**  -  same combo is reusable forever. Table fills once, then weekly
runs are no-ops (idempotent existence check).

### Inputs

- **Phases:** all 8 (`new`, `waxingCrescent`, `firstQuarter`, `waxingGibbous`, `full`, `waningGibbous`, `lastQuarter`, `waningCrescent`)
- **Signs:** all 12 zodiac signs
- **Locales:** all 14 from `routing.locales`
- **Model:** `openai/gpt-5-mini` via Vercel AI Gateway

**Total combos:** 8 × 12 × 14 = **1344**.

### Anti-AI prompt rules

The system prompt enforces:
- No semicolons, em dashes, or en dashes
- No LLM-tells ("navigate", "delve", "tapestry", etc.)
- No "not X, but Y" rhetorical pattern
- No tricolons / three-item lists
- No product-specific jargon in operator-facing output

A post-filter strips any em/en dashes or semicolons that slip through, just
in case.

### Output

```sql
(moon_phase, moon_sign, locale, body, model, prompt_version, generated_at)
PRIMARY KEY (moon_phase, moon_sign, locale)
```
Schema in [`00005_moon_forecast.sql`](../supabase/migrations/00005_moon_forecast.sql).

### Cost

- One-time fill: 1344 × ~$0.0009 ≈ **~$1.20 lifetime**
- Subsequent weekly runs: $0 (all cached)

### Manual trigger

```bash
cd apps/pwa && npm run cron:moon
```

Filter combos:
```bash
SECRET=$(grep "^INTERNAL_API_SECRET=" apps/pwa/.env.local | cut -d= -f2-)
curl -X POST -H "x-internal-secret: $SECRET" \
  "http://localhost:3206/api/cron/moon-forecast?phase=full&sign=leo&locale=lt&force=1"
```

### Verification

```sql
SELECT count(*) FROM moon_forecast;          -- expect 1344 when full
SELECT moon_phase, moon_sign, locale, left(body, 80)
FROM moon_forecast
WHERE locale = 'en'
ORDER BY moon_phase, moon_sign;
```

---

## Job: Daily Focus

**Path:** `/api/cron/daily-focus` ([source](../apps/pwa/src/app/api/cron/daily-focus/route.ts))
**Schedule:** `5 0 * * *`  -  every day at 00:05 UTC
**Status:** ✅ Live since 2026-04-28

### What it does

Generates the AI-written one-line "Focus of the Day" filter phrase for every
combination of `(date, sun_sign, locale)` in the catalog, then upserts into
the `daily_focus` Supabase table. The dashboard HomePage Section II reads this
table at request time  -  no runtime AI calls.

Generates **today and tomorrow** in the same run as a timezone-safety buffer
(if Vercel Cron lags or fails, tomorrow's data is already there).

### Inputs

- **Sun signs:** all 12 zodiac signs (`aries`..`pisces`)
- **Locales:** all 14 from `routing.locales` (`en`, `lt`, `lv`, `cs`, `hu`, `sk`, `ro`, `ru`, `zh-TW`, `el`, `he`, `pl`, `hr`, `da`)
- **Sky context per generation:** `computeDailySky(date)`  -  moon phase, moon sign, top transit
- **Model:** `openai/gpt-5-mini` via Vercel AI Gateway
- **Per-generation token budget:** ~400 in + 30 out

**Total generations per cron run:** 12 signs × 14 locales × 2 days = **336**.

### Output

Each successful generation upserts a row into `public.daily_focus`:
```sql
(date, sun_sign, locale, phrase, model, prompt_version, generated_at)
```
Schema in [`00003_daily_focus.sql`](../supabase/migrations/00003_daily_focus.sql).

Records are kept **indefinitely**  -  provides historical archive and audit trail.

### Cost

- gpt-5-mini ~ $0.25/M input, $2.00/M output
- Per generation: ~$0.00016
- Per cron run (336 calls): ~$0.054
- **Per month: ~$1.65**  -  does not scale with DAU.

### Failure modes

- **AI Gateway down:** specific generations fail, others succeed. Failed ones
  don't write a row; HomePage shows "Today's filter is being prepared."
  fallback for that combo. Next day's run retries naturally.
- **Vercel Cron skipped a day:** tomorrow buffer covers it (we always
  generate today + tomorrow). Two consecutive misses = fallback shown.
- **Supabase down:** entire run fails, retry next day. Manual trigger
  available via `INTERNAL_API_SECRET`.

### Manual trigger

**Local  -  one command, all 14 locales × 12 signs × 2 days (~30–60s with concurrency 25):**
```bash
cd apps/pwa && npm run cron:focus
```

**Filter to one combo (debugging):**
```bash
SECRET=$(grep "^INTERNAL_API_SECRET=" apps/pwa/.env.local | cut -d= -f2-)
curl -X POST -H "x-internal-secret: $SECRET" \
  "http://localhost:3206/api/cron/daily-focus?locale=lt&sign=leo&force=1"
```

`?force=1` regenerates even if a row exists. Without it, existing rows are
skipped (idempotent).

### Verification

After a run, check the response JSON:
```json
{
  "ok": true,
  "dates": ["2026-04-28", "2026-04-29"],
  "locales": [...],
  "signs": [...],
  "counts": { "total": 336, "generated": 336, "cached": 0, "failed": 0 },
  "failures": []
}
```

Then sample a few rows in Supabase:
```sql
SELECT date, sun_sign, locale, phrase
FROM daily_focus
WHERE date = current_date
ORDER BY sun_sign, locale;
```

---

## Job: Daily Content

**Path:** `/api/cron/daily-content` ([source](../apps/pwa/src/app/api/cron/daily-content/route.ts))
**Schedule:** `10 0 * * *`  -  every day at 00:10 UTC (5 min after Daily Focus to spread load)
**Status:** ✅ Live since 2026-04-28

### What it does

Generates the four AI-written texts that fill HomePage sections III, V, VI, VII
for every `(date, sun_sign, locale)` combo, then upserts into `daily_content`.
One AI call returns all four texts (Horoscope, Remember, Ritual, Practice),
which keeps input-token cost flat  -  only output-token cost grows by ~4×.

Generates **today and tomorrow** in the same run as a timezone-safety buffer.

### Inputs

- **Sun signs:** all 12 zodiac signs
- **Locales:** all 14 from `routing.locales`
- **Sky context:** `computeDailySky(date)` shared with Daily Focus
- **Model:** `openai/gpt-5-mini` via Vercel AI Gateway
- **Per-generation token budget:** ~600 in + ~400 out

**Total generations per cron run:** 12 × 14 × 2 = **336**.

### Output

Each successful generation upserts a row into `public.daily_content`:
```sql
(date, sun_sign, locale, horoscope, remember, ritual, practice, model, prompt_version, generated_at)
```
Schema in [`00004_daily_content.sql`](../supabase/migrations/00004_daily_content.sql).

Records are kept **indefinitely**.

### Cost

- gpt-5-mini ~ $0.25/M input, $2.00/M output
- Per generation: ~$0.0009 (4× output of focus, same input class)
- Per cron run (336 calls): ~$0.30
- **Per month: ~$5–7**  -  does not scale with DAU.

### Failure modes

Same shape as Daily Focus. Failed generations write no row; HomePage shows
"Today's reading is being prepared." fallback for affected sections.
Tomorrow buffer covers single-day cron skips.

### Manual trigger

```bash
cd apps/pwa && npm run cron:content
```

Filter to one combo:
```bash
SECRET=$(grep "^INTERNAL_API_SECRET=" apps/pwa/.env.local | cut -d= -f2-)
curl -X POST -H "x-internal-secret: $SECRET" \
  "http://localhost:3206/api/cron/daily-content?locale=lt&sign=leo&force=1"
```

### Verification

```sql
SELECT date, sun_sign, locale, left(horoscope, 60) AS preview
FROM daily_content
WHERE date = current_date
ORDER BY sun_sign, locale;
```

---

## Adding a new cron job

When you add a new scheduled job:

1. **Create the handler** at `apps/pwa/src/app/api/cron/<job-name>/route.ts`.
   Reuse the auth pattern from `daily-focus` (accept both `CRON_SECRET` and
   `INTERNAL_API_SECRET`).
2. **Register the schedule** in `apps/pwa/vercel.json` under `crons[]`.
3. **Add a row** to the **Active Jobs** table at the top of this file.
4. **Add a detailed section** following the Daily Focus template:
   purpose, inputs, output schema, cost estimate, failure modes,
   manual-trigger command, and verification query.
5. **Set `maxDuration`** in the route module  -  match the worst-case run
   length so Vercel doesn't kill it mid-loop.

### Naming convention

Path segments use kebab-case: `daily-focus`, `weekly-digest`, `prune-stale-tokens`.
Match the pretty name in the table to the path slug for grep-ability.

### Cost discipline

Every new AI-driven cron deserves a one-line cost estimate at the top of its
section. Math should answer: "if user count 10×, does cost change?" Document
the answer.

### Idempotency

Treat each cron run as potentially repeated. Always upsert (PK conflict),
gate writes behind a "row already exists" check, or accept a `?force=1` param
for explicit re-runs. Do not generate side-effects that aren't safe to repeat.
