-- ═════════════════════════════════════════════════════════════════════════════
-- FUNNEL BOILERPLATE — BASELINE SCHEMA
--
-- One squashed, idempotent migration. Re-running it against an existing
-- database is a no-op (CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS + CREATE). It contains only platform schema: the funnel
-- quiz session store, OTP auth rate limiting, orders + entitlements, and the
-- complete Solidgate payment machinery (webhook idempotency, entity ordering,
-- checkout state machines, card vaults, outboxes).
--
-- WHAT YOU EDIT PER PRODUCT
--   Section 2 (PRODUCT CATALOG) is the only place where product/offer names
--   live. It must stay in lockstep with the TypeScript catalog in
--   packages/shared (price-map.ts, oto-product-label.ts, entitlements.ts) and
--   with supabase/functions/solidgate-webhooks/_codes.ts. If SQL and TS drift,
--   checkout fails loudly with SQLSTATE 23514 ("invalid Solidgate main
--   original amount") rather than silently mispricing — that is deliberate.
--
-- CONVENTIONS (keep them)
--   * No enums, no domains. Every enumerated value is TEXT + CHECK, so adding
--     a value is an ALTER ... CHECK instead of an enum migration.
--   * Every table gets ENABLE ROW LEVEL SECURITY *and* REVOKE ALL FROM anon,
--     authenticated. RLS alone is not enough: Supabase grants anon and
--     authenticated table privileges by default, and a table with RLS off is
--     world-writable through PostgREST. This was a real, reproduced hole on
--     renewal_events (anon POST returned 201) before it was closed.
--   * gen_random_uuid() comes from pgcrypto, which Supabase enables by
--     default. Do not add an explicit CREATE EXTENSION for it.
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. SEQUENCES
-- ═════════════════════════════════════════════════════════════════════════════

-- Totally orders every card source across orders and card-update attempts, so
-- "is this token newer than the one already vaulted?" is a single integer
-- comparison instead of a timestamp race.
CREATE SEQUENCE IF NOT EXISTS public.solidgate_card_source_sequence AS BIGINT;
REVOKE ALL ON SEQUENCE public.solidgate_card_source_sequence
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.solidgate_card_source_sequence TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. PRODUCT CATALOG   ◀── EDIT THIS SECTION PER PRODUCT
--
-- These five IMMUTABLE resolvers are the ONLY place the schema knows anything
-- about your offers. Everything else in this file is product-agnostic.
--
-- They mirror, one-for-one, the TypeScript catalog:
--   packages/shared/src/price-map.ts            (product ids + offering codes)
--   packages/shared/src/oto-product-label.ts    (ProductKey union)
--   supabase/functions/solidgate-webhooks/_codes.ts
-- Change one side and you MUST change the other. Drift does not corrupt data —
-- guard_solidgate_main_payable_order() raises SQLSTATE 23514 and the checkout
-- fails — but it does take checkout down, so change them in one commit.
--
-- The placeholder catalog below is a 1 main subscription + 8 OTO demo:
--   BRAND_000000_SUB           main subscription  (intro tiers trial1..trial4,
--                                                  special_1eur, special_free)
--   BRANDLIFETIME_000000_SUB   OTO step 1
--   BRANDADDON_000000_SUB      OTO step 2 (recurring add-on)
--   BRANDBUNDLE*_000000_PDF    OTO step 3 (choose one of four variants)
--   BRANDPDF4..7_000000_PDF    OTO steps 4-7
--   (OTO step 8 is the summary page and has no purchasable product)
-- ═════════════════════════════════════════════════════════════════════════════

-- Provider offering code → funnel OTO step. IMMUTABLE because
-- idx_orders_solidgate_one_live_oto_step is an expression index over it: after
-- editing this function you must REINDEX that index, or the "one live order per
-- OTO step" guarantee silently stops holding for the new codes.
CREATE OR REPLACE FUNCTION public.solidgate_oto_step_from_product_slug(
  p_product_slug TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT CASE p_product_slug
    WHEN 'BRANDLIFETIME_000000_SUB' THEN 1
    WHEN 'BRANDADDON_000000_SUB' THEN 2
    WHEN 'BRANDBUNDLE_000000_PDF' THEN 3
    WHEN 'BRANDBUNDLE1_000000_PDF' THEN 3
    WHEN 'BRANDBUNDLE2_000000_PDF' THEN 3
    WHEN 'BRANDBUNDLE3_000000_PDF' THEN 3
    WHEN 'BRANDPDF4_000000_PDF' THEN 4
    WHEN 'BRANDPDF5_000000_PDF' THEN 5
    WHEN 'BRANDPDF6_000000_PDF' THEN 6
    WHEN 'BRANDPDF7_000000_PDF' THEN 7
    ELSE NULL
  END
$$;

-- Internal product id (the key in PRICE_MAP) → funnel OTO step.
CREATE OR REPLACE FUNCTION public.solidgate_oto_step_from_internal_slug(
  p_internal_slug TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT CASE p_internal_slug
    WHEN 'oto1_lifetime' THEN 1
    WHEN 'oto2_addon_weekly' THEN 2
    WHEN 'oto3_bundle_all' THEN 3
    WHEN 'oto3_bundle_1' THEN 3
    WHEN 'oto3_bundle_2' THEN 3
    WHEN 'oto3_bundle_3' THEN 3
    WHEN 'oto4_pdf' THEN 4
    WHEN 'oto5_pdf' THEN 5
    WHEN 'oto6_pdf' THEN 6
    WHEN 'oto7_pdf' THEN 7
    ELSE NULL
  END
$$;

-- sessions.last_oto_step is TEXT so it can hold anything; this narrows it to a
-- real step. NULL last_oto_step means "has not started the chain" = step 1.
-- Generic: the 1..8 range is the OTO chain length, not a product fact.
CREATE OR REPLACE FUNCTION public.solidgate_persisted_oto_step(
  p_last_oto_step TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_last_oto_step IS NULL THEN 1
    WHEN p_last_oto_step IN ('1', '2', '3', '4', '5', '6', '7', '8')
      THEN p_last_oto_step::INTEGER
    ELSE NULL
  END
$$;

-- Member-area offer id → provider offering code. Only the offers that can be
-- bought from inside the app appear here.
CREATE OR REPLACE FUNCTION public.solidgate_pwa_product_code(p_offer_slug TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE p_offer_slug
    WHEN 'oto2_addon_weekly' THEN 'BRANDADDON_000000_SUB'
    WHEN 'oto3_bundle_all' THEN 'BRANDBUNDLE_000000_PDF'
    WHEN 'oto3_bundle_1' THEN 'BRANDBUNDLE1_000000_PDF'
    WHEN 'oto3_bundle_2' THEN 'BRANDBUNDLE2_000000_PDF'
    WHEN 'oto3_bundle_3' THEN 'BRANDBUNDLE3_000000_PDF'
    WHEN 'oto4_pdf' THEN 'BRANDPDF4_000000_PDF'
    WHEN 'oto5_pdf' THEN 'BRANDPDF5_000000_PDF'
    WHEN 'oto6_pdf' THEN 'BRANDPDF6_000000_PDF'
    WHEN 'oto7_pdf' THEN 'BRANDPDF7_000000_PDF'
    ELSE NULL
  END
$$;

-- Authoritative gross for a main checkout, per intro tier and currency.
--
-- WHY THE DATABASE KNOWS PRICES: the browser sends the amount it thinks it is
-- paying. Without a server-side table an attacker can post trial4 with a
-- trial1 amount. guard_solidgate_main_payable_order() compares the inserted
-- amount_cents against this function on INSERT and rejects a mismatch, so the
-- price table cannot be bypassed from the client.
--
-- These are PLACEHOLDER DEMO PRICES. EUR is the base; every other currency is
-- a flat demo conversion, rounded to a clean number, at these fixed rates:
--   usd 1.00   czk 25   huf 400   ron 5   twd 35
--   ils 4      pln 4    dkk 8     jpy 200
-- JPY is a zero-decimal currency, so its "minor units" are whole yen.
--
-- THIS GRID IS GENERATED FROM packages/shared/src/price-map.ts AND MUST STAY
-- IDENTICAL TO IT. price-map.ts is the source of truth: it derives every amount
-- from PRODUCT_SPECS[].eurCents x CURRENCY_DEMO_FACTORS[currency]. If the two
-- drift, guard_solidgate_main_payable_order() rejects the INSERT and every
-- checkout in the affected currency fails with SQLSTATE 23514.
-- Replace the whole grid with your real per-market prices before launch.
CREATE OR REPLACE FUNCTION public.solidgate_main_checkout_amount(
  p_offer_slug TEXT,
  p_currency TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE p_offer_slug
    WHEN 'trial1' THEN CASE LOWER(p_currency)          -- EUR 5.00
      WHEN 'eur' THEN 500 WHEN 'usd' THEN 500 WHEN 'czk' THEN 12500
      WHEN 'huf' THEN 200000 WHEN 'ron' THEN 2500 WHEN 'twd' THEN 17500
      WHEN 'ils' THEN 2000 WHEN 'pln' THEN 2000 WHEN 'dkk' THEN 4000
      WHEN 'jpy' THEN 1000 END
    WHEN 'trial2' THEN CASE LOWER(p_currency)          -- EUR 9.00
      WHEN 'eur' THEN 900 WHEN 'usd' THEN 900 WHEN 'czk' THEN 22500
      WHEN 'huf' THEN 360000 WHEN 'ron' THEN 4500 WHEN 'twd' THEN 31500
      WHEN 'ils' THEN 3600 WHEN 'pln' THEN 3600 WHEN 'dkk' THEN 7200
      WHEN 'jpy' THEN 1800 END
    WHEN 'trial3' THEN CASE LOWER(p_currency)          -- EUR 13.00
      WHEN 'eur' THEN 1300 WHEN 'usd' THEN 1300 WHEN 'czk' THEN 32500
      WHEN 'huf' THEN 520000 WHEN 'ron' THEN 6500 WHEN 'twd' THEN 45500
      WHEN 'ils' THEN 5200 WHEN 'pln' THEN 5200 WHEN 'dkk' THEN 10400
      WHEN 'jpy' THEN 2600 END
    WHEN 'trial4' THEN CASE LOWER(p_currency)          -- EUR 17.00
      WHEN 'eur' THEN 1700 WHEN 'usd' THEN 1700 WHEN 'czk' THEN 42500
      WHEN 'huf' THEN 680000 WHEN 'ron' THEN 8500 WHEN 'twd' THEN 59500
      WHEN 'ils' THEN 6800 WHEN 'pln' THEN 6800 WHEN 'dkk' THEN 13600
      WHEN 'jpy' THEN 3400 END
    WHEN 'special_1eur' THEN CASE LOWER(p_currency)    -- EUR 1.00
      WHEN 'eur' THEN 100 WHEN 'usd' THEN 100 WHEN 'czk' THEN 2500
      WHEN 'huf' THEN 40000 WHEN 'ron' THEN 500 WHEN 'twd' THEN 3500
      WHEN 'ils' THEN 400 WHEN 'pln' THEN 400 WHEN 'dkk' THEN 800
      WHEN 'jpy' THEN 200 END
    -- Zero-auth tier: the card is authorized for 0 and only charged at the
    -- first renewal. Access is gated on holding a REUSABLE token — see
    -- solidgate_special_free_card_ready() in section 7. If your funnel has no
    -- free tier, delete this branch and the 'special_free' CHECK values.
    WHEN 'special_free' THEN CASE LOWER(p_currency)    -- EUR 0.00
      WHEN 'eur' THEN 0 WHEN 'usd' THEN 0 WHEN 'czk' THEN 0
      WHEN 'huf' THEN 0 WHEN 'ron' THEN 0 WHEN 'twd' THEN 0
      WHEN 'ils' THEN 0 WHEN 'pln' THEN 0 WHEN 'dkk' THEN 0
      WHEN 'jpy' THEN 0 END
    ELSE NULL
  END
$$;
-- ═════════════════════════════════════════════════════════════════════════════
-- 3. CORE FUNNEL TABLES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── sessions ────────────────────────────────────────────────────────────────
-- One anonymous funnel session per visitor, linked to an auth user after the
-- post-checkout OTP. quiz_answers is a free-form JSONB bag so the quiz can
-- change shape without a migration.
CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  visitor_id TEXT,
  quiz_answers JSONB NOT NULL DEFAULT '{}'::JSONB,
  quiz_result JSONB,
  result_segment TEXT,
  current_step_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 0,
  quiz_variant TEXT NOT NULL DEFAULT 'boilerplate-v1',
  funnel_variant TEXT NOT NULL DEFAULT 'main-v1',
  locale TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'quiz',
  attribution JSONB NOT NULL DEFAULT '{}'::JSONB,
  client_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- Per-step CRO telemetry: {"<step_id>": {viewed_at, answered_at, skipped, views}}.
  -- Timestamps are stamped server-side by quiz_merge_step_activity(); the client
  -- only ever sends step ids. NOT answers — quiz_answers remains the sole home
  -- for those, and nothing here is per-answer or per-row.
  step_activity JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- Auth linking (post-checkout OTP)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- OTO chain progress: '1'..'8', advanced only by advance_solidgate_oto_progress.
  last_oto_step TEXT,
  -- Pins the whole OTO chain of one session to a single payment environment.
  solidgate_oto_environment TEXT,

  -- GDPR consent
  consent_given_at TIMESTAMPTZ,
  consent_version TEXT,
  marketing_consent BOOLEAN DEFAULT true,

  -- Defer the welcome email until payment confirms.
  welcome_email_pending BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT sessions_solidgate_oto_environment_check CHECK (
    solidgate_oto_environment IS NULL
    OR solidgate_oto_environment IN ('production', 'sandbox')
  ),
  CONSTRAINT sessions_status_check CHECK (
    status IN ('active', 'completed', 'abandoned', 'expired')
  ),
  CONSTRAINT sessions_revision_check CHECK (revision >= 0),
  CONSTRAINT sessions_quiz_answers_object_check CHECK (
    jsonb_typeof(quiz_answers) = 'object'
  ),
  CONSTRAINT sessions_quiz_result_object_check CHECK (
    quiz_result IS NULL OR jsonb_typeof(quiz_result) = 'object'
  ),
  CONSTRAINT sessions_attribution_object_check CHECK (
    jsonb_typeof(attribution) = 'object'
  ),
  CONSTRAINT sessions_client_context_object_check CHECK (
    jsonb_typeof(client_context) = 'object'
  ),
  CONSTRAINT sessions_step_activity_object_check CHECK (
    jsonb_typeof(step_activity) = 'object'
  ),
  CONSTRAINT sessions_completion_check CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  )
);

-- Keep the baseline idempotent when it is re-run against an older local
-- boilerplate database instead of a completely fresh reset.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS visitor_id TEXT;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS quiz_result JSONB;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS quiz_variant TEXT NOT NULL DEFAULT 'boilerplate-v1';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS funnel_variant TEXT NOT NULL DEFAULT 'main-v1';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS attribution JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS client_context JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS step_activity JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_status_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_status_check
      CHECK (status IN ('active', 'completed', 'abandoned', 'expired'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_revision_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_revision_check CHECK (revision >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_quiz_answers_object_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_quiz_answers_object_check
      CHECK (jsonb_typeof(quiz_answers) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_quiz_result_object_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_quiz_result_object_check
      CHECK (quiz_result IS NULL OR jsonb_typeof(quiz_result) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_attribution_object_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_attribution_object_check
      CHECK (jsonb_typeof(attribution) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_client_context_object_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_client_context_object_check
      CHECK (jsonb_typeof(client_context) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_step_activity_object_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_step_activity_object_check
      CHECK (jsonb_typeof(step_activity) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_completion_check' AND conrelid = 'public.sessions'::regclass
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT sessions_completion_check
      CHECK ((status = 'completed') = (completed_at IS NOT NULL));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_sessions_email ON public.sessions (email);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_current_step ON public.sessions (current_step_id);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor_id ON public.sessions (visitor_id)
  WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_quiz_reporting
  ON public.sessions (created_at, funnel_variant, quiz_variant, source, status);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can create a session" ON public.sessions;
-- Quiz session creation goes through /api/quiz/session/create so the server can pin the
-- quiz version, mint the signed access cookie and create quiz_started in the
-- same transaction. There is intentionally no direct anonymous INSERT policy.

DROP POLICY IF EXISTS "Authenticated users can read their own sessions" ON public.sessions;
CREATE POLICY "Authenticated users can read their own sessions"
  ON public.sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Authenticated users can update their own sessions" ON public.sessions;
CREATE POLICY "Authenticated users can update their own sessions"
  ON public.sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ── funnel_events ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.funnel_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'quiz_started', 'step_completed', 'lead_captured', 'quiz_completed',
    'results_viewed', 'offer_viewed', 'offer_accepted', 'offer_declined',
    'oto_viewed', 'oto_accepted', 'oto_declined', 'checkout_completed'
  )),
  step_number INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.funnel_events
  ADD COLUMN IF NOT EXISTS event_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.funnel_events
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE public.funnel_events SET metadata = '{}'::JSONB WHERE metadata IS NULL;
ALTER TABLE public.funnel_events ALTER COLUMN metadata SET NOT NULL;
ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check;
ALTER TABLE public.funnel_events
  ADD CONSTRAINT funnel_events_event_type_check CHECK (event_type IN (
    'quiz_started', 'step_completed', 'lead_captured', 'quiz_completed',
    'results_viewed', 'offer_viewed', 'offer_accepted', 'offer_declined',
    'oto_viewed', 'oto_accepted', 'oto_declined', 'checkout_completed'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_events_event_id
  ON public.funnel_events (event_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_session_id ON public.funnel_events (session_id);
CREATE INDEX IF NOT EXISTS idx_funnel_events_event_type ON public.funnel_events (event_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_events_one_session_milestone
  ON public.funnel_events (session_id, event_type)
  WHERE event_type IN ('quiz_started', 'lead_captured', 'quiz_completed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_events_one_step_completion
  ON public.funnel_events (session_id, event_type, step_number)
  WHERE event_type = 'step_completed';

ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;

-- The hardened funnel-event path uses authenticated backend routes. Direct
-- browser writes remain temporarily available for the existing frontend; the
-- backend-only quiz branch adds /api/funnel-events but does not switch callers.
-- Remove these policies when the frontend migration is explicitly in scope.
DROP POLICY IF EXISTS "Anyone can insert funnel events" ON public.funnel_events;
CREATE POLICY "Anyone can insert funnel events"
  ON public.funnel_events FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "Authenticated can insert funnel events" ON public.funnel_events;
CREATE POLICY "Authenticated can insert funnel events"
  ON public.funnel_events FOR INSERT TO authenticated WITH CHECK (true);

-- ── quiz definition catalog ─────────────────────────────────────────────────
-- Publishes the TypeScript quiz graph (apps/funnel/src/features/quiz/config/
-- quiz-config.ts) into Postgres so an EXTERNAL CRO dashboard can label steps
-- and tell a BRANCH from a DROP.
--
-- WHY THIS EXISTS. funnel_events records only step_number, and
-- idx_funnel_events_one_step_completion is unique on
-- (session_id, event_type, step_number) — while branch arms SHARE a position
-- (step3 and step3b are both position 3). So one session can record at most
-- one arm, the step id survives only inside metadata.step_id, and per-step
-- counts dip at every branch even when nobody dropped. See the comment in
-- apps/funnel/src/app/admin/_queries/funnel.ts that concedes exactly this.
-- These tables are the only thing that can separate the two cases; do not
-- "simplify" them back into funnel_events.
--
-- THESE TABLES HOLD NO USER DATA. They describe the quiz's own structure, one
-- set of rows per quiz_variant, shared by every session — roughly 18 rows for
-- an 8-step quiz, and they do not grow with traffic. Answers live in
-- sessions.quiz_answers and nowhere else; there is no per-answer, per-session
-- or per-view row anywhere in this catalog.
--
-- KEYED ON quiz_variant ALONE. quiz_variant is the immutable question set;
-- funnel_variant is the INDEPENDENT per-visitor presentation/offer A/B bucket
-- assigned by assign_funnel_variant in the app. One definition serves many
-- funnel_variants. funnel_key below is a descriptive family label, NOT part of
-- the key — sessions carries no funnel-family column to join on.
--
-- DELIBERATELY NOT REFERENCED BY sessions. There is no FK from
-- sessions.quiz_variant to quiz_definitions.quiz_variant and there must never
-- be one: session creation is on the revenue path and must not fail because a
-- deploy forgot to seed the catalog. The join is a LEFT JOIN; an unseeded
-- variant shows up in cro_step_funnel() as in_catalog = false, which is how
-- you find out.
--
-- APPEND-ONLY AND IMMUTABLE. There is no is_active flag by design: changing
-- the quiz means bumping QUIZ_VARIANT in
-- apps/funnel/src/features/quiz/server/quiz-definition.ts, and old versions
-- stop receiving sessions on their own. Several versions being live at once is
-- therefore the normal case, not a state anyone toggles.
CREATE TABLE IF NOT EXISTS public.quiz_definitions (
  quiz_variant   TEXT PRIMARY KEY,
  app_key        TEXT NOT NULL,
  funnel_key     TEXT NOT NULL,
  first_step_id  TEXT NOT NULL,
  total_steps    INTEGER NOT NULL,
  -- sha256 over the STRUCTURE of the step graph (ids, positions, types,
  -- storeAs, option values, successor edges) — never over i18n copy keys.
  -- Copy edits are the most common CRO change; if they forced a variant bump
  -- someone would disable this guard within two months.
  config_hash    TEXT NOT NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quiz_definitions_variant_len
    CHECK (char_length(quiz_variant) BETWEEN 1 AND 100),
  CONSTRAINT quiz_definitions_app_key_len
    CHECK (char_length(app_key) BETWEEN 1 AND 100),
  CONSTRAINT quiz_definitions_funnel_key_len
    CHECK (char_length(funnel_key) BETWEEN 1 AND 100),
  CONSTRAINT quiz_definitions_first_step_len
    CHECK (char_length(first_step_id) BETWEEN 1 AND 100),
  CONSTRAINT quiz_definitions_total_steps_check
    CHECK (total_steps BETWEEN 1 AND 500),
  CONSTRAINT quiz_definitions_config_hash_check
    CHECK (config_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_quiz_definitions_family
  ON public.quiz_definitions (app_key, funnel_key, published_at DESC);

ALTER TABLE public.quiz_definitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quiz_definitions FROM PUBLIC, anon, authenticated;
-- No DELETE: removing a definition orphans the step labels of every historical
-- session that ran it.
GRANT SELECT, INSERT ON TABLE public.quiz_definitions TO service_role;

COMMENT ON TABLE public.quiz_definitions IS
  'Published immutable quiz question-set versions. Soft-referenced by sessions.quiz_variant; never FK-enforced. Contains no user data.';


-- ── quiz_definition_steps ───────────────────────────────────────────────────
-- BRANCH ALTERNATIVES SHARE A POSITION. step3 and step3b are both position 3
-- (STEP_POSITIONS in quiz-config.ts). There is intentionally NO unique index
-- on (quiz_variant, position) — adding one makes every branching quiz
-- unpublishable. The stable per-step key is step_id; sort_index carries the
-- config's declaration order.
CREATE TABLE IF NOT EXISTS public.quiz_definition_steps (
  quiz_variant  TEXT NOT NULL
    REFERENCES public.quiz_definitions(quiz_variant) ON DELETE CASCADE,
  step_id       TEXT NOT NULL,
  position      INTEGER NOT NULL,
  sort_index    INTEGER NOT NULL,
  step_type     TEXT NOT NULL,
  phase_key     TEXT,
  store_as      TEXT,
  -- allowedKeysForStep(step).length > 0 in
  -- apps/funnel/src/features/quiz/config/step-answer-keys.ts. This is the only
  -- reliable question-vs-screen signal: step_completed fires for auto-advancing
  -- screens too, so the event alone cannot distinguish them.
  is_question   BOOLEAN NOT NULL,
  is_terminal   BOOLEAN NOT NULL DEFAULT false,
  answer_keys   JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- The declared answer CODES for this step, in config order ("o1", "female").
  -- Not copy — the labels beside them in quiz-config.ts are i18n keys.
  --
  -- Two jobs. It is part of the config hash, so changing a step's option
  -- vocabulary now forces a QUIZ_VARIANT bump rather than silently letting one
  -- variant hold two vocabularies. And it lets an answer distribution say
  -- "no longer an option" instead of rendering a bare code for an answer whose
  -- option was later removed.
  option_values JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- Resolved English copy for those codes, as {"o1": "Lose weight", ...}.
  --
  -- SEPARATE FROM option_values, and deliberately NOT part of the config hash,
  -- for the same reason `label` is not: every string in quiz-config.ts is an
  -- i18n key, copy edits are the most common CRO change there is, and if they
  -- forced a QUIZ_VARIANT bump someone would disable the guard within two
  -- months. The CODES are structure and are hashed; the words beside them are
  -- not.
  --
  -- An object rather than a parallel array so the `?` membership test on
  -- option_values keeps working unchanged, and so a missing entry is simply a
  -- NULL lookup rather than an index that has to line up.
  option_labels JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- The i18n key the label came from, kept so a dashboard can be localised
  -- later without republishing.
  label_key     TEXT,
  -- Resolved English text. EVERY string in quiz-config.ts is an i18n key, not a
  -- sentence -- that is what makes the quiz translatable -- so publishing the
  -- config faithfully yields 'steps.step1.question', which is no more readable
  -- in a dashboard than 'step1'. The publisher resolves it against the message
  -- pack before it gets here.
  label         TEXT,
  -- True when EVERY route from the first step to a terminal passes through this
  -- step. Decided by deleting the step and asking whether any terminal is still
  -- reachable -- NOT by whether it shares a position. That heuristic is wrong in
  -- both directions and is the single reason a branch gets reported as a drop.
  --
  -- Consumers split a position's screens on this: `true` screens are on the
  -- spine and their drop is real; `false` screens were only shown to some
  -- visitors, so their drop must be measured against their OWN views.
  is_unconditional BOOLEAN NOT NULL DEFAULT true,
  -- True when an entry condition can route a visitor PAST this step entirely,
  -- which is what makes a "never saw this question" count meaningful rather than
  -- a drop. The boilerplate schema has no skipIf concept, so it is always false
  -- here; products that have one populate it.
  entry_skippable  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (quiz_variant, step_id),
  CONSTRAINT quiz_definition_steps_step_id_len
    CHECK (char_length(step_id) BETWEEN 1 AND 100),
  CONSTRAINT quiz_definition_steps_position_check
    CHECK (position BETWEEN 1 AND 500),
  CONSTRAINT quiz_definition_steps_type_len
    CHECK (char_length(step_type) BETWEEN 1 AND 50),
  CONSTRAINT quiz_definition_steps_answer_keys_array_check
    CHECK (jsonb_typeof(answer_keys) = 'array'),
  CONSTRAINT quiz_definition_steps_option_values_array_check
    CHECK (jsonb_typeof(option_values) = 'array'),
  CONSTRAINT quiz_definition_steps_option_labels_object_check
    CHECK (jsonb_typeof(option_labels) = 'object')
);

ALTER TABLE public.quiz_definition_steps
  ADD COLUMN IF NOT EXISTS option_values JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE public.quiz_definition_steps
  ADD COLUMN IF NOT EXISTS option_labels JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE public.quiz_definition_steps ADD COLUMN IF NOT EXISTS label_key TEXT;
ALTER TABLE public.quiz_definition_steps ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE public.quiz_definition_steps
  ADD COLUMN IF NOT EXISTS is_unconditional BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.quiz_definition_steps
  ADD COLUMN IF NOT EXISTS entry_skippable BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_quiz_definition_steps_position
  ON public.quiz_definition_steps (quiz_variant, position, step_id);

ALTER TABLE public.quiz_definition_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quiz_definition_steps FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.quiz_definition_steps TO service_role;


-- ── quiz_definition_step_edges ──────────────────────────────────────────────
-- Explicit successor ids. This is what makes reachability computable, and it
-- is what separates a BRANCH from a DROP: "step S was viewed and NONE of S's
-- successors was viewed" is a real exit; "step T was never viewed because the
-- visitor took the other arm out of S" is not.
--
-- Terminal steps (loading_screen, trial_price) emit NO edges. quiz-config.ts
-- gives step7 nextStepId = 'step7' as an unused placeholder; the no-self-edge
-- CHECK below rejects it on purpose, so the publisher must filter terminals
-- out. Without that, every terminal step becomes a phantom cycle in the
-- dashboard's graph.
CREATE TABLE IF NOT EXISTS public.quiz_definition_step_edges (
  quiz_variant  TEXT NOT NULL,
  from_step_id  TEXT NOT NULL,
  to_step_id    TEXT NOT NULL,
  edge_index    INTEGER NOT NULL DEFAULT 0,
  -- The option value that selects this edge, or NULL for a step-level
  -- nextStepId. multi_select / likert / slider / input_group cannot branch.
  on_value      TEXT,
  PRIMARY KEY (quiz_variant, from_step_id, to_step_id, edge_index),
  FOREIGN KEY (quiz_variant, from_step_id)
    REFERENCES public.quiz_definition_steps (quiz_variant, step_id) ON DELETE CASCADE,
  FOREIGN KEY (quiz_variant, to_step_id)
    REFERENCES public.quiz_definition_steps (quiz_variant, step_id) ON DELETE CASCADE,
  CONSTRAINT quiz_definition_step_edges_no_self
    CHECK (from_step_id <> to_step_id),
  CONSTRAINT quiz_definition_step_edges_on_value_len
    CHECK (on_value IS NULL OR char_length(on_value) BETWEEN 1 AND 200),
  CONSTRAINT quiz_definition_step_edges_index_check
    CHECK (edge_index BETWEEN 0 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_quiz_definition_step_edges_from
  ON public.quiz_definition_step_edges (quiz_variant, from_step_id, to_step_id);

ALTER TABLE public.quiz_definition_step_edges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quiz_definition_step_edges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.quiz_definition_step_edges TO service_role;


-- A published definition is FROZEN. Historical sessions' step_number and
-- step_activity keys are interpreted against it, so mutating it silently
-- rewrites the meaning of data already collected. Re-publishing an unchanged
-- config is a no-op; re-publishing a CHANGED one is an error telling the
-- operator to bump QUIZ_VARIANT.
CREATE OR REPLACE FUNCTION public.guard_quiz_definition_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'QUIZ_DEFINITION_IMMUTABLE:' || TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS guard_quiz_definitions_immutable_trigger
  ON public.quiz_definitions;
CREATE TRIGGER guard_quiz_definitions_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.quiz_definitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_quiz_definition_immutable();

DROP TRIGGER IF EXISTS guard_quiz_definition_steps_immutable_trigger
  ON public.quiz_definition_steps;
CREATE TRIGGER guard_quiz_definition_steps_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.quiz_definition_steps
  FOR EACH ROW EXECUTE FUNCTION public.guard_quiz_definition_immutable();

DROP TRIGGER IF EXISTS guard_quiz_definition_step_edges_immutable_trigger
  ON public.quiz_definition_step_edges;
CREATE TRIGGER guard_quiz_definition_step_edges_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.quiz_definition_step_edges
  FOR EACH ROW EXECUTE FUNCTION public.guard_quiz_definition_immutable();


-- Idempotent publish, called by scripts/publish-quiz-definition.ts.
--
--   same variant + same hash  -> {"result":"unchanged"}, ZERO writes
--   same variant + diff hash  -> QUIZ_DEFINITION_DRIFT, the publish fails loud
--   new variant               -> header + steps + edges inserted
--
-- The "zero writes" path is load-bearing: the immutability trigger would
-- reject a re-publish UPDATE outright, so this must short-circuit BEFORE it
-- writes rather than rely on the write failing.
CREATE OR REPLACE FUNCTION public.publish_quiz_definition(
  p_quiz_variant  TEXT,
  p_app_key       TEXT,
  p_funnel_key    TEXT,
  p_first_step_id TEXT,
  p_total_steps   INTEGER,
  p_config_hash   TEXT,
  -- [{step_id, position, sort_index, step_type, phase_key, store_as,
  --   is_question, is_terminal, answer_keys:[], next:[{to_step_id, on_value}]}]
  p_steps         JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.quiz_definitions%ROWTYPE;
  v_step     JSONB;
  v_next     JSONB;
  v_index    INTEGER;
BEGIN
  IF jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'QUIZ_DEFINITION_STEPS_INVALID';
  END IF;

  SELECT * INTO v_existing
  FROM public.quiz_definitions
  WHERE quiz_variant = p_quiz_variant;

  IF FOUND THEN
    IF v_existing.config_hash = p_config_hash THEN
      RETURN jsonb_build_object(
        'result', 'unchanged',
        'quiz_variant', v_existing.quiz_variant,
        'config_hash', v_existing.config_hash
      );
    END IF;
    -- The workflow this enforces: every quiz change gets a NEW quiz_variant.
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'QUIZ_DEFINITION_DRIFT:' || v_existing.config_hash;
  END IF;

  INSERT INTO public.quiz_definitions (
    quiz_variant, app_key, funnel_key, first_step_id, total_steps, config_hash
  ) VALUES (
    p_quiz_variant, p_app_key, p_funnel_key, p_first_step_id,
    p_total_steps, p_config_hash
  );

  -- Steps first: the edge table FKs both endpoints back to them, which is also
  -- what rejects an edge pointing at a step id the config does not define.
  FOR v_step IN SELECT * FROM jsonb_array_elements(p_steps)
  LOOP
    INSERT INTO public.quiz_definition_steps (
      quiz_variant, step_id, position, sort_index, step_type,
      phase_key, store_as, is_question, is_terminal, answer_keys, option_values,
      option_labels, label_key, label, is_unconditional, entry_skippable
    ) VALUES (
      p_quiz_variant,
      v_step ->> 'step_id',
      (v_step ->> 'position')::INTEGER,
      (v_step ->> 'sort_index')::INTEGER,
      v_step ->> 'step_type',
      v_step ->> 'phase_key',
      v_step ->> 'store_as',
      COALESCE((v_step ->> 'is_question')::BOOLEAN, false),
      COALESCE((v_step ->> 'is_terminal')::BOOLEAN, false),
      COALESCE(v_step -> 'answer_keys', '[]'::JSONB),
      COALESCE(v_step -> 'option_values', '[]'::JSONB),
      COALESCE(v_step -> 'option_labels', '{}'::JSONB),
      v_step ->> 'label_key',
      v_step ->> 'label',
      COALESCE((v_step ->> 'is_unconditional')::BOOLEAN, true),
      COALESCE((v_step ->> 'entry_skippable')::BOOLEAN, false)
    );
  END LOOP;

  FOR v_step IN SELECT * FROM jsonb_array_elements(p_steps)
  LOOP
    v_index := 0;
    FOR v_next IN SELECT * FROM jsonb_array_elements(COALESCE(v_step -> 'next', '[]'::JSONB))
    LOOP
      INSERT INTO public.quiz_definition_step_edges (
        quiz_variant, from_step_id, to_step_id, edge_index, on_value
      ) VALUES (
        p_quiz_variant,
        v_step ->> 'step_id',
        v_next ->> 'to_step_id',
        v_index,
        v_next ->> 'on_value'
      )
      ON CONFLICT DO NOTHING;
      v_index := v_index + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'result', 'published',
    'quiz_variant', p_quiz_variant,
    'config_hash', p_config_hash,
    'steps', jsonb_array_length(p_steps)
  );
END;
$$;


-- Merge one per-save step-activity DELTA into a session's step_activity.
--
-- INTERNAL: revoked from service_role too. Reachable only from inside
-- create_quiz_session and save_quiz_session_progress, both SECURITY DEFINER.
--
-- The delta is {"viewed":[ids],"answered":[ids],"skipped":[ids]} — step IDS
-- ONLY. The client never sends a timestamp, so a skewed or hostile clock
-- cannot move any of these. `viewed` is a MULTISET (one entry per forward
-- entry, which is the view counter); the other two are sets.
--
-- Semantics, which the SQL tests pin:
--   viewed_at   COALESCE -> FIRST view, never moves
--   answered_at COALESCE -> FIRST answer. A visitor who navigates back and
--                           edits does NOT reset it: this is "when did they
--                           first get past this step", not "last changed".
--   skipped     answering clears it; skipping never un-answers
--   views       +1 per forward entry, capped so a looping client cannot
--               inflate it without bound
--
-- It deliberately does NOT validate ids against quiz_definition_steps: that
-- would make every save depend on the catalog being seeded, breaking the
-- soft-reference rule. Unknown ids surface as in_catalog = false in
-- cro_step_funnel(), which is the drift detector.
CREATE OR REPLACE FUNCTION public.quiz_merge_step_activity(
  p_existing JSONB,
  p_delta    JSONB,
  p_now      TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result    JSONB := COALESCE(p_existing, '{}'::JSONB);
  v_now_json  JSONB := to_jsonb(p_now);
  v_viewed    JSONB;
  v_answered  JSONB;
  v_skipped   JSONB;
  v_step      TEXT;
  v_is_view   BOOLEAN;
  v_is_answer BOOLEAN;
  v_is_skip   BOOLEAN;
  v_view_n    INTEGER;
  v_entry     JSONB;
  v_views     INTEGER;
BEGIN
  IF p_delta IS NULL OR jsonb_typeof(p_delta) <> 'object' THEN
    RETURN v_result;
  END IF;

  v_viewed   := CASE WHEN jsonb_typeof(p_delta -> 'viewed')   = 'array'
                     THEN p_delta -> 'viewed'   ELSE '[]'::JSONB END;
  v_answered := CASE WHEN jsonb_typeof(p_delta -> 'answered') = 'array'
                     THEN p_delta -> 'answered' ELSE '[]'::JSONB END;
  v_skipped  := CASE WHEN jsonb_typeof(p_delta -> 'skipped')  = 'array'
                     THEN p_delta -> 'skipped'  ELSE '[]'::JSONB END;

  -- One pass per distinct step id. view_n counts REPEATS within this delta, so
  -- two forward entries in one save increment views by two.
  FOR v_step, v_is_view, v_is_answer, v_is_skip, v_view_n IN
    SELECT d.step_id,
           bool_or(d.kind = 'v'),
           bool_or(d.kind = 'a'),
           bool_or(d.kind = 's'),
           count(*) FILTER (WHERE d.kind = 'v')::INTEGER
    FROM (
      SELECT 'v'::TEXT AS kind, t.value AS step_id
        FROM jsonb_array_elements_text(v_viewed) AS t(value)
      UNION ALL
      SELECT 'a', t.value FROM jsonb_array_elements_text(v_answered) AS t(value)
      UNION ALL
      SELECT 's', t.value FROM jsonb_array_elements_text(v_skipped) AS t(value)
    ) AS d
    WHERE d.step_id IS NOT NULL
    GROUP BY d.step_id
  LOOP
    IF char_length(v_step) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'QUIZ_STEP_ACTIVITY_INVALID';
    END IF;

    v_entry := COALESCE(v_result -> v_step, '{}'::JSONB);
    v_views := COALESCE((v_entry ->> 'views')::INTEGER, 0);

    IF v_is_view THEN
      v_views := LEAST(v_views + v_view_n, 250);
    ELSE
      -- Answering or skipping without an explicit view still implies one.
      v_views := GREATEST(v_views, 1);
    END IF;

    v_result := v_result || jsonb_build_object(
      v_step,
      jsonb_build_object(
        'viewed_at',
          COALESCE(v_entry -> 'viewed_at', v_now_json),
        'answered_at',
          CASE
            WHEN v_entry ->> 'answered_at' IS NOT NULL THEN v_entry -> 'answered_at'
            WHEN v_is_answer THEN v_now_json
            ELSE 'null'::JSONB
          END,
        'skipped',
          CASE
            WHEN v_is_answer THEN 'false'::JSONB
            WHEN v_entry ->> 'answered_at' IS NOT NULL THEN 'false'::JSONB
            WHEN v_is_skip THEN 'true'::JSONB
            ELSE COALESCE(v_entry -> 'skipped', 'false'::JSONB)
          END,
        'views', to_jsonb(v_views)
      )
    );
  END LOOP;

  -- Bound the RESULT. The column CHECK is a shape guard only; this raises a
  -- sentinel the API route turns into a 413 instead of a bare 23514.
  IF pg_column_size(v_result) > 16384
     OR (SELECT count(*) FROM jsonb_object_keys(v_result)) > 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'QUIZ_STEP_ACTIVITY_TOO_LARGE';
  END IF;

  RETURN v_result;
END;
$$;
-- ── quiz backend atomic operations ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_quiz_session(
  p_session_id UUID,
  p_email TEXT,
  p_visitor_id TEXT,
  p_quiz_variant TEXT,
  p_funnel_variant TEXT,
  p_locale TEXT,
  p_source TEXT,
  p_attribution JSONB,
  p_client_context JSONB,
  p_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
BEGIN
  INSERT INTO public.sessions (
    id,
    email,
    visitor_id,
    quiz_variant,
    funnel_variant,
    locale,
    source,
    attribution,
    client_context,
    step_activity
  ) VALUES (
    p_session_id,
    p_email,
    p_visitor_id,
    p_quiz_variant,
    p_funnel_variant,
    p_locale,
    p_source,
    COALESCE(p_attribution, '{}'::JSONB),
    COALESCE(p_client_context, '{}'::JSONB),
    -- Stamp the landing step as viewed. Nobody ever advances INTO the first
    -- step, so without this its viewed_at stays null forever and
    -- "rendered step 1 and bounced" is indistinguishable from "row exists,
    -- screen never rendered" -- which DATA_MODEL.md calls the whole point of
    -- creating this row before any click.
    --
    -- SOFT catalog reference: no FK, no join in the INSERT's WHERE, no failure
    -- path. An unpublished quiz_variant yields NULL and the session is created
    -- with an empty step_activity. Session creation is on the revenue path and
    -- must never fail because a deploy forgot to seed the catalog.
    COALESCE(
      (
        SELECT public.quiz_merge_step_activity(
                 '{}'::JSONB,
                 jsonb_build_object('viewed', jsonb_build_array(d.first_step_id)),
                 now()
               )
        FROM public.quiz_definitions d
        WHERE d.quiz_variant = p_quiz_variant
      ),
      '{}'::JSONB
    )
  )
  RETURNING * INTO v_session;

  INSERT INTO public.funnel_events (
    event_id,
    session_id,
    event_type,
    step_number,
    metadata,
    occurred_at
  ) VALUES (
    p_event_id,
    p_session_id,
    'quiz_started',
    1,
    '{}'::JSONB,
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'id', v_session.id,
    'status', v_session.status,
    'revision', v_session.revision,
    'current_step_id', v_session.current_step_id
  );
END;
$$;

-- ORDER BELOW IS LOAD-BEARING.
--
-- 1) Adding a parameter does NOT replace this function. CREATE OR REPLACE with
--    a different argument count creates an OVERLOAD, and PostgREST then sees
--    two candidates for POST /rpc/save_quiz_session_progress and fails EVERY
--    call with PGRST203. The 13-argument signature must be dropped explicitly.
-- 2) IF EXISTS keeps the re-run safe: on a second run only the 14-argument
--    form is present and the DROP is a no-op.
-- 3) p_step_activity is LAST and has DEFAULT NULL, so every existing
--    13-argument POSITIONAL call stays valid (supabase/tests/quiz_backend.sql)
--    and a deploy is safe while PostgREST's schema cache is still stale.
DROP FUNCTION IF EXISTS public.save_quiz_session_progress(
  UUID, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN,
  UUID, TEXT, INTEGER, JSONB
);

CREATE OR REPLACE FUNCTION public.save_quiz_session_progress(
  p_session_id UUID,
  p_expected_revision INTEGER,
  p_quiz_answers JSONB,
  p_current_step_id TEXT,
  p_email TEXT,
  p_locale TEXT,
  p_consent_given_at TIMESTAMPTZ,
  p_consent_version TEXT,
  p_marketing_consent BOOLEAN,
  p_event_id UUID,
  p_event_type TEXT,
  p_event_step_number INTEGER,
  p_event_metadata JSONB,
  -- {"viewed":[ids],"answered":[ids],"skipped":[ids]} -- step ids only, never
  -- client timestamps. See quiz_merge_step_activity() for the merge contract.
  p_step_activity JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
  v_existing public.sessions%ROWTYPE;
  v_now TIMESTAMPTZ := now();   -- one stamp for the whole call
BEGIN
  UPDATE public.sessions
  SET
    quiz_answers = p_quiz_answers,
    current_step_id = COALESCE(p_current_step_id, current_step_id),
    email = COALESCE(p_email, email),
    locale = COALESCE(p_locale, locale),
    consent_given_at = COALESCE(p_consent_given_at, consent_given_at),
    consent_version = COALESCE(p_consent_version, consent_version),
    marketing_consent = COALESCE(p_marketing_consent, marketing_consent),
    -- step_activity on the RIGHT-hand side is the PRE-update value, so the
    -- first-view COALESCE and the view increment both see the stored entry.
    -- Keeping the merge inside this same revision-guarded UPDATE is what
    -- removes the read-modify-write window; do not lift it into a second
    -- statement.
    step_activity = public.quiz_merge_step_activity(
      step_activity, p_step_activity, v_now
    ),
    welcome_email_pending = CASE
      WHEN p_email IS NOT NULL THEN true
      ELSE welcome_email_pending
    END,
    revision = revision + 1,
    updated_at = v_now
  WHERE id = p_session_id
    AND status = 'active'
    AND revision = p_expected_revision
  RETURNING * INTO v_session;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
    FROM public.sessions
    WHERE id = p_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'QUIZ_SESSION_NOT_FOUND';
    END IF;

    IF v_existing.status <> 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'QUIZ_SESSION_TERMINAL';
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'QUIZ_STALE_REVISION:' || v_existing.revision::TEXT;
  END IF;

  IF p_event_id IS NOT NULL AND p_event_type IS NOT NULL THEN
    INSERT INTO public.funnel_events (
      event_id,
      session_id,
      event_type,
      step_number,
      metadata,
      occurred_at
    ) VALUES (
      p_event_id,
      p_session_id,
      p_event_type,
      p_event_step_number,
      COALESCE(p_event_metadata, '{}'::JSONB),
      v_now
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'id', v_session.id,
    'status', v_session.status,
    'revision', v_session.revision,
    'current_step_id', v_session.current_step_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_quiz_session(
  p_session_id UUID,
  p_expected_revision INTEGER,
  p_quiz_result JSONB,
  p_result_segment TEXT,
  p_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'QUIZ_SESSION_NOT_FOUND';
  END IF;

  IF v_session.status = 'completed' THEN
    RETURN jsonb_build_object(
      'id', v_session.id,
      'status', v_session.status,
      'revision', v_session.revision,
      'quiz_result', v_session.quiz_result,
      'result_segment', v_session.result_segment,
      'completed_at', v_session.completed_at
    );
  END IF;

  IF v_session.status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'QUIZ_SESSION_TERMINAL';
  END IF;

  IF v_session.revision <> p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'QUIZ_STALE_REVISION:' || v_session.revision::TEXT;
  END IF;

  UPDATE public.sessions
  SET
    quiz_result = p_quiz_result,
    result_segment = p_result_segment,
    status = 'completed',
    current_step_id = 'results',
    completed_at = now(),
    updated_at = now(),
    revision = revision + 1
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  INSERT INTO public.funnel_events (
    event_id,
    session_id,
    event_type,
    metadata,
    occurred_at
  ) VALUES (
    p_event_id,
    p_session_id,
    'quiz_completed',
    jsonb_build_object('result_segment', p_result_segment),
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'id', v_session.id,
    'status', v_session.status,
    'revision', v_session.revision,
    'quiz_result', v_session.quiz_result,
    'result_segment', v_session.result_segment,
    'completed_at', v_session.completed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_funnel_event(
  p_event_id UUID,
  p_session_id UUID,
  p_event_type TEXT,
  p_step_number INTEGER,
  p_metadata JSONB,
  p_occurred_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.funnel_events (
    event_id,
    session_id,
    event_type,
    step_number,
    metadata,
    occurred_at
  ) VALUES (
    p_event_id,
    p_session_id,
    p_event_type,
    p_step_number,
    COALESCE(p_metadata, '{}'::JSONB),
    COALESCE(p_occurred_at, now())
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.funnel_events
    WHERE event_id = p_event_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.link_quiz_session_user(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'QUIZ_SESSION_NOT_FOUND';
  END IF;

  IF v_session.user_id IS NOT NULL AND v_session.user_id <> p_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'QUIZ_SESSION_OWNERSHIP_MISMATCH';
  END IF;

  IF v_session.user_id IS NULL THEN
    UPDATE public.sessions
    SET user_id = p_user_id, updated_at = now()
    WHERE id = p_session_id
    RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object('id', v_session.id, 'user_id', v_session.user_id);
END;
$$;

-- Per-step CRO aggregate for the external dashboard.
--
-- This is a FUNCTION rather than a view because PostgREST's .select() cannot
-- aggregate over jsonb_each, and the admin _queries "one COUNT per step"
-- pattern cannot reach inside step_activity at all.
--
-- BRANCH vs DROP, which is the entire point of the catalog:
--   * BRANCH -- two steps share a `position`. A visitor traverses one arm, so
--     the other arm simply has no entry for that session. Read it against
--     position_cohort: the arms' `viewed` sum to roughly that number and
--     nothing was lost.
--   * DROP -- `dropped` counts sessions that viewed this step, viewed NONE of
--     its successors in quiz_definition_step_edges, and did not complete. That
--     is a real exit no matter which arm they were on.
--
-- Returns COUNTS ONLY. No session ids, no emails, no answers, so this is safe
-- to expose to a narrower analytics role later without granting table SELECT.
--
-- EVERY column reference below is alias-qualified and GROUP BY / ORDER BY use
-- ordinals: in a RETURNS TABLE function the output column names are parameters,
-- and a bare `quiz_variant` in the body is ambiguous (42702).
-- ═════════════════════════════════════════════════════════════════════════════
-- CRO DASHBOARD READ API
--
-- apps/cro holds ONLY the anon key. It never sees SUPABASE_SERVICE_ROLE_KEY,
-- and apps/cro/src/lib/no-service-role.test.ts fails the build if it ever does.
-- So every read it performs goes through a SECURITY DEFINER function below,
-- granted to `authenticated` and gated on is_cro_analyst().
--
-- WHY THE CHECK IS INSIDE THE FUNCTION rather than left to the GRANT: the role
-- `authenticated` is every signed-in PWA member, not the analyst team. The
-- member area and this dashboard share one Supabase auth directory.
--
-- WHY NOT RLS: RLS is a row filter; what is needed here is an AGGREGATION
-- boundary. A policy on public.sessions would hand an analyst whole rows —
-- email, quiz_answers, client_context.ip_address — and RLS cannot express
-- "you may see COUNT(*) but not the rows". The catalog tables are revoked at
-- the GRANT level anyway, so an RLS approach would first have to open them to
-- every logged-in customer.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── cro_analysts ────────────────────────────────────────────────────────────
-- Who may read the dashboard. A table rather than an env allowlist because
-- membership should be data, not a production deploy.
--
-- In practice this holds ONE row: the shared PMC Hub identity seeded below.
-- Individual access is governed by PMC Hub roles, not here. The table and every
-- check against it remain exactly as they were — that is the point of the
-- design, not an oversight. Adding a second row is still supported and is how
-- you would grant someone direct access without going through the hub.
CREATE TABLE IF NOT EXISTS public.cro_analysts (
  -- Lowercased, matching how is_cro_analyst() compares. The second CHECK is not
  -- decoration: is_cro_analyst() compares against
  -- lower(COALESCE(auth.jwt() ->> 'email', '')), so a single empty-string row
  -- would grant the whole dashboard to every JWT carrying no email claim.
  email      TEXT PRIMARY KEY
    CHECK (email = lower(email) AND email LIKE '_%@_%'),
  -- Free text: who this is, who approved them, when to review the access.
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cro_analysts ENABLE ROW LEVEL SECURITY;
-- RLS on with zero policies denies everything to non-BYPASSRLS roles, and
-- is_cro_analyst() reads it as the definer. An analyst must not be able to
-- enumerate colleagues.
REVOKE ALL ON public.cro_analysts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cro_analysts TO service_role;

COMMENT ON TABLE public.cro_analysts IS
  'Allowlist for the CRO dashboard. Read only by is_cro_analyst(); never exposed to authenticated.';

-- THE ONLY SEEDED ROW IN THIS BASELINE, and it is here rather than in
-- supabase/seed.sql or the new-product checklist on purpose. seed.sql does not
-- run on a hosted `db push`, and a checklist step gets missed — either way the
-- board is an empty screen for everybody, with nothing on it to say why. The
-- schema is the only place that always runs.
--
-- This address is the shared identity PMC Hub mints as. It is not a mailbox
-- anyone reads day to day, but it IS a real one, and anyone who can read it can
-- sign in to this board directly with an emailed code. Treat access to that
-- mailbox as equivalent to access to every product's CRO board.
--
-- ON CONFLICT DO NOTHING so re-running the baseline is safe, and so a product
-- that has edited the note or added its own analysts is never trampled.
INSERT INTO public.cro_analysts (email, note)
VALUES ('cro@pmcbaltic.com', 'PMC Hub shared analyst — see docs/cro-dropoff.md')
ON CONFLICT (email) DO NOTHING;


CREATE OR REPLACE FUNCTION public.is_cro_analyst()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.cro_analysts a
    WHERE a.email = lower(COALESCE(auth.jwt() ->> 'email', ''))
  );
$$;

-- Deliberately NOT PARALLEL SAFE: auth.jwt() is not declared parallel-safe, and
-- neither is anything that calls this.
REVOKE ALL ON FUNCTION public.is_cro_analyst() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_cro_analyst() TO authenticated, service_role;


-- ── anon-side OTP rate limit ────────────────────────────────────────────────
-- packages/shared/src/auth/otp-rate-limit.ts uses the admin client, so apps/cro
-- cannot use it. These two wrap the existing otp_attempts ledger for a caller
-- holding only the anon key.
--
-- Both short-circuit on a non-analyst address. Without that, the endpoint is a
-- team-roster oracle (ask about an address, watch whether it rate-limits) and
-- anyone could burn a colleague's attempts to lock them out.
CREATE OR REPLACE FUNCTION public.cro_check_otp_rate_limit(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email TEXT := lower(COALESCE(p_email, ''));
  v_recent INTEGER;
BEGIN
  -- Unknown address: report "allowed" and let the caller proceed to a sign-in
  -- that quietly does nothing. Reporting "blocked" would confirm the address.
  IF NOT EXISTS (SELECT 1 FROM public.cro_analysts a WHERE a.email = v_email) THEN
    RETURN true;
  END IF;

  SELECT count(*) INTO v_recent
  FROM public.otp_attempts o
  WHERE o.email = v_email
    AND o.attempted_at > now() - INTERVAL '15 minutes'
    AND NOT o.success;

  RETURN v_recent < 5;
END;
$$;

CREATE OR REPLACE FUNCTION public.cro_record_otp_attempt(
  p_email   TEXT,
  p_success BOOLEAN,
  p_ip      TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email TEXT := lower(COALESCE(p_email, ''));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cro_analysts a WHERE a.email = v_email) THEN
    RETURN;
  END IF;

  INSERT INTO public.otp_attempts (email, ip_address, success)
  VALUES (v_email, left(COALESCE(p_ip, ''), 100), COALESCE(p_success, false));
END;
$$;

REVOKE ALL ON FUNCTION public.cro_check_otp_rate_limit(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cro_record_otp_attempt(TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cro_check_otp_rate_limit(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cro_record_otp_attempt(TEXT, BOOLEAN, TEXT) TO anon, authenticated, service_role;
-- Which funnels, quiz versions and locales saw traffic in the window.
--
-- Drives the dashboard's pickers. The rule the dashboard applies is simply
-- "render a picker when a list has more than one entry", which is what lets one
-- dashboard serve a product with many funnels and one version (glp-app) and a
-- product with one funnel and many versions (carnivore-app) without knowing
-- which is which.
--
-- Deliberately NOT filtered by the current selection: it is the escape hatch
-- from a filter that selected an empty window.
CREATE OR REPLACE FUNCTION public.cro_funnel_segments(
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ
)
RETURNS TABLE (
  kind       TEXT,
  id         TEXT,
  sessions   BIGINT,
  first_seen TIMESTAMPTZ,
  last_seen  TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $$
BEGIN
  -- The gate. `authenticated` is every signed-in PWA member, so EXECUTE alone
  -- is not the boundary; this is. 42501 rather than an empty result, because
  -- apps/cro branches on the SQLSTATE to render "ask for access" instead of a
  -- board that merely looks like a quiet day.
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bounds AS (
  SELECT COALESCE(p_from, now() - INTERVAL '30 days') AS lo,
         COALESCE(p_to,   now())                      AS hi
),
scoped AS (
  -- client_context is projected by NAMED KEY only, never whole: it also carries
  -- ip_address, user_agent and city, and this function is the boundary that
  -- keeps those away from an analyst holding a valid JWT.
  SELECT s.funnel_variant, s.quiz_variant, s.locale, s.source, s.created_at,
         COALESCE(NULLIF(s.client_context ->> 'device_type', ''), 'unknown') AS device,
         COALESCE(NULLIF(s.client_context ->> 'country', ''), 'unknown')     AS country
  FROM public.sessions s
  CROSS JOIN bounds b
  WHERE s.created_at >= b.lo AND s.created_at < b.hi
)
SELECT 'funnel'::TEXT, sc.funnel_variant, count(*), min(sc.created_at), max(sc.created_at)
FROM scoped sc GROUP BY 2
UNION ALL
SELECT 'version'::TEXT, sc.quiz_variant, count(*), min(sc.created_at), max(sc.created_at)
FROM scoped sc GROUP BY 2
UNION ALL
SELECT 'locale'::TEXT, sc.locale, count(*), min(sc.created_at), max(sc.created_at)
FROM scoped sc GROUP BY 2
UNION ALL
SELECT 'device'::TEXT, sc.device, count(*), min(sc.created_at), max(sc.created_at)
FROM scoped sc GROUP BY 2
UNION ALL
SELECT 'country'::TEXT, sc.country, count(*), min(sc.created_at), max(sc.created_at)
FROM scoped sc GROUP BY 2
UNION ALL
SELECT 'source'::TEXT, sc.source, count(*), min(sc.created_at), max(sc.created_at)
FROM scoped sc GROUP BY 2
ORDER BY 1, 3 DESC, 2;
END;
$$;


-- Adding a parameter creates an OVERLOAD; PostgREST then fails every call with
-- PGRST203. Drop the previous signature explicitly. p_locale is appended LAST
-- with a default so existing positional calls stay valid.
DROP FUNCTION IF EXISTS public.cro_step_funnel(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTERVAL
);

CREATE OR REPLACE FUNCTION public.cro_step_funnel(
  p_from            TIMESTAMPTZ,
  p_to              TIMESTAMPTZ,
  p_quiz_variant    TEXT     DEFAULT NULL,
  p_funnel_variant  TEXT     DEFAULT NULL,
  p_source          TEXT     DEFAULT NULL,
  -- A session that started two minutes ago has not "dropped", it is still being
  -- taken. Without this any window touching now() overstates drop-off on
  -- whatever step the newest cohort happens to be sitting on.
  p_settled_after   INTERVAL DEFAULT INTERVAL '2 hours',
  p_locale          TEXT     DEFAULT NULL
)
RETURNS TABLE (
  quiz_variant          TEXT,
  funnel_variant        TEXT,
  step_id               TEXT,
  step_position         INTEGER,
  sort_index            INTEGER,
  step_type             TEXT,
  phase_key             TEXT,
  label                 TEXT,
  is_question           BOOLEAN,
  is_terminal           BOOLEAN,
  is_unconditional      BOOLEAN,
  entry_skippable       BOOLEAN,
  in_catalog            BOOLEAN,
  has_traffic           BOOLEAN,
  position_cohort       BIGINT,
  viewed                BIGINT,
  answered              BIGINT,
  skipped               BIGINT,
  advanced              BIGINT,
  dropped               BIGINT,
  unsettled             BIGINT,
  total_views           BIGINT,
  revisits              BIGINT,
  p50_seconds_to_answer DOUBLE PRECISION,
  p90_seconds_to_answer DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
BEGIN
  -- The gate. `authenticated` is every signed-in PWA member, so EXECUTE alone
  -- is not the boundary; this is. 42501 rather than an empty result, because
  -- apps/cro branches on the SQLSTATE to render "ask for access" instead of a
  -- board that merely looks like a quiet day.
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bounds AS (
  SELECT COALESCE(p_from, now() - INTERVAL '30 days')  AS lo,
         COALESCE(p_to,   now())                       AS hi,
         now() - COALESCE(p_settled_after, INTERVAL '0') AS settled_before
),
-- created_at, NOT updated_at: updated_at moves on every save, so a range over
-- it is not reproducible. The metric is "sessions that STARTED in the window".
scoped AS (
  SELECT s.id, s.quiz_variant, s.funnel_variant, s.status,
         s.updated_at, s.step_activity
  FROM public.sessions s
  CROSS JOIN bounds b
  WHERE s.created_at >= b.lo
    AND s.created_at <  b.hi
    AND (p_quiz_variant   IS NULL OR s.quiz_variant   = p_quiz_variant)
    AND (p_funnel_variant IS NULL OR s.funnel_variant = p_funnel_variant)
    AND (p_source         IS NULL OR s.source         = p_source)
    AND (p_locale         IS NULL OR s.locale         = p_locale)
),
-- Every (quiz, funnel) pair that saw ANY session, including ones whose
-- step_activity is still empty. This is what the skeleton hangs off.
variants AS (
  SELECT DISTINCT sc.quiz_variant AS v_quiz_variant,
                  sc.funnel_variant AS v_funnel_variant
  FROM scoped sc
),
activity AS (
  SELECT sc.id,
         sc.quiz_variant   AS a_quiz_variant,
         sc.funnel_variant AS a_funnel_variant,
         sc.status,
         sc.updated_at,
         a.key                                             AS a_step_id,
         (a.value ->> 'viewed_at')::TIMESTAMPTZ            AS viewed_at,
         (a.value ->> 'answered_at')::TIMESTAMPTZ          AS answered_at,
         COALESCE((a.value ->> 'skipped')::BOOLEAN, false) AS was_skipped,
         COALESCE((a.value ->> 'views')::INTEGER, 1)       AS view_count,
         -- jsonb `?` tests key existence against the object already in memory:
         -- no second expansion, no self-join back onto sessions.
         EXISTS (
           SELECT 1
           FROM public.quiz_definition_step_edges e
           WHERE e.quiz_variant = sc.quiz_variant
             AND e.from_step_id = a.key
             AND sc.step_activity ? e.to_step_id
         ) AS advanced
  FROM scoped sc
  CROSS JOIN LATERAL jsonb_each(sc.step_activity) AS a(key, value)
  WHERE sc.step_activity <> '{}'::JSONB
),
agg AS (
  SELECT ac.a_quiz_variant   AS g_quiz_variant,
         ac.a_funnel_variant AS g_funnel_variant,
         ac.a_step_id        AS g_step_id,
         count(*)                                          AS g_viewed,
         count(*) FILTER (WHERE ac.answered_at IS NOT NULL) AS g_answered,
         count(*) FILTER (WHERE ac.was_skipped)             AS g_skipped,
         count(*) FILTER (WHERE ac.advanced)                AS g_advanced,
         count(*) FILTER (
           WHERE NOT ac.advanced
             AND ac.status <> 'completed'
             AND ac.updated_at < (SELECT b.settled_before FROM bounds b)
         )                                                  AS g_dropped_raw,
         count(*) FILTER (
           WHERE NOT ac.advanced
             AND ac.status <> 'completed'
             AND ac.updated_at >= (SELECT b.settled_before FROM bounds b)
         )                                                  AS g_unsettled,
         -- sum(bigint) returns NUMERIC, and RETURN QUERY is strict about the
         -- declared BIGINT where LANGUAGE sql used to coerce silently.
         COALESCE(sum(ac.view_count), 0)::BIGINT            AS g_total_views,
         COALESCE(sum(GREATEST(ac.view_count - 1, 0)), 0)::BIGINT AS g_revisits,
         -- percentile_cont ignores NULL inputs, so unanswered steps fall out on
         -- their own. The cast is required: EXTRACT returns numeric on PG14+.
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (ac.answered_at - ac.viewed_at))::DOUBLE PRECISION
         )                                                  AS g_p50,
         percentile_cont(0.9) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (ac.answered_at - ac.viewed_at))::DOUBLE PRECISION
         )                                                  AS g_p90,
         count(DISTINCT ac.id)                              AS g_sessions
  FROM activity ac
  GROUP BY 1, 2, 3
),
-- EVERY published step for every variant that saw traffic, so a step nobody
-- reached still produces a row. Without this the funnel list simply ends at the
-- deepest step anyone got to, and "nobody reached it" is indistinguishable from
-- "it does not exist" -- which also hides a routing bug that shows a step to
-- zero people.
skeleton AS (
  SELECT v.v_quiz_variant   AS k_quiz_variant,
         v.v_funnel_variant AS k_funnel_variant,
         st.step_id         AS k_step_id
  FROM variants v
  JOIN public.quiz_definition_steps st ON st.quiz_variant = v.v_quiz_variant
),
keys AS (
  SELECT sk.k_quiz_variant, sk.k_funnel_variant, sk.k_step_id FROM skeleton sk
  UNION
  -- Activity for a step the catalog does not know: surfaced as in_catalog =
  -- false rather than dropped, because that IS the drift detector.
  SELECT g.g_quiz_variant, g.g_funnel_variant, g.g_step_id FROM agg g
),
joined AS (
  SELECT k.k_quiz_variant, k.k_funnel_variant, k.k_step_id,
         st.position, st.sort_index, st.step_type, st.phase_key, st.label,
         st.is_question, st.is_terminal, st.is_unconditional, st.entry_skippable,
         (st.step_id IS NOT NULL) AS in_catalog,
         g.*
  FROM keys k
  LEFT JOIN agg g
    ON  g.g_quiz_variant   = k.k_quiz_variant
    AND g.g_funnel_variant = k.k_funnel_variant
    AND g.g_step_id        = k.k_step_id
  LEFT JOIN public.quiz_definition_steps st
    ON  st.quiz_variant = k.k_quiz_variant
    AND st.step_id      = k.k_step_id
),
cohort AS (
  -- Denominator for the branch split: how many sessions reached ANY step at
  -- this position, within this quiz/funnel pair.
  SELECT j.k_quiz_variant   AS c_quiz_variant,
         j.k_funnel_variant AS c_funnel_variant,
         j.position         AS c_position,
         COALESCE(sum(j.g_viewed), 0)::BIGINT AS c_cohort
  FROM joined j
  WHERE j.position IS NOT NULL
  GROUP BY 1, 2, 3
)
SELECT
  j.k_quiz_variant,
  j.k_funnel_variant,
  j.k_step_id,
  j.position,
  j.sort_index,
  j.step_type,
  j.phase_key,
  j.label,
  COALESCE(j.is_question, false),
  COALESCE(j.is_terminal, false),
  COALESCE(j.is_unconditional, false),
  COALESCE(j.entry_skippable, false),
  j.in_catalog,
  (COALESCE(j.g_viewed, 0) > 0)                AS has_traffic,
  COALESCE(c.c_cohort, 0)                      AS position_cohort,
  COALESCE(j.g_viewed, 0)                      AS viewed,
  COALESCE(j.g_answered, 0)                    AS answered,
  COALESCE(j.g_skipped, 0)                     AS skipped,
  COALESCE(j.g_advanced, 0)                    AS advanced,
  -- A terminal step is never "dropped": there is nothing after it to advance to.
  CASE WHEN COALESCE(j.is_terminal, false) THEN 0
       ELSE COALESCE(j.g_dropped_raw, 0) END   AS dropped,
  COALESCE(j.g_unsettled, 0)                   AS unsettled,
  COALESCE(j.g_total_views, 0)                 AS total_views,
  COALESCE(j.g_revisits, 0)                    AS revisits,
  j.g_p50,
  j.g_p90
FROM joined j
LEFT JOIN cohort c
  ON  c.c_quiz_variant   = j.k_quiz_variant
  AND c.c_funnel_variant = j.k_funnel_variant
  AND c.c_position       IS NOT DISTINCT FROM j.position
ORDER BY 4 NULLS LAST, 5 NULLS LAST, 3;
END;
$$;
REVOKE ALL ON FUNCTION public.create_quiz_session(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_quiz_session_progress(UUID, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, TEXT, INTEGER, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_quiz_session(UUID, INTEGER, JSONB, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_funnel_event(UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_quiz_session_user(UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_quiz_session(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_quiz_session_progress(UUID, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, TEXT, INTEGER, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_quiz_session(UUID, INTEGER, JSONB, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_funnel_event(UUID, UUID, TEXT, INTEGER, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_quiz_session_user(UUID, UUID) TO service_role;

-- CRO definition catalog + step activity.
--
-- quiz_merge_step_activity is revoked from service_role TOO: it is internal,
-- reachable only from inside create_quiz_session and
-- save_quiz_session_progress, both of which are SECURITY DEFINER. Granting it
-- would let a caller rewrite a session's telemetry directly.
REVOKE ALL ON FUNCTION public.quiz_merge_step_activity(JSONB, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_quiz_definition_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_quiz_definition(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
-- REWRITTEN, not appended. CREATE OR REPLACE PRESERVES a function's ACL, so
-- leaving the old "REVOKE ... FROM authenticated" in place would silently strip
-- the grant below on every `supabase db reset`.
--
-- `authenticated` may now EXECUTE these, but that is not the boundary — the
-- is_cro_analyst() guard inside each function is. apps/cro holds only the anon
-- key, so a SECURITY DEFINER function is the ONLY way it reads anything.
REVOKE ALL ON FUNCTION public.cro_step_funnel(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTERVAL, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cro_funnel_segments(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.publish_quiz_definition(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.cro_step_funnel(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTERVAL, TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.cro_funnel_segments(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;


-- ── cro_quiz_catalog ────────────────────────────────────────────────────────
-- The published quiz structure, flattened. apps/cro cannot read
-- quiz_definition_steps directly (revoked from authenticated), yet
-- assembleFunnelResponse needs config_hash / first_step_id / total_steps /
-- terminal ids, and the Answers tab needs store_as + answer_keys + option_values
-- to build its question picker.
--
-- Safe to expose whole: it describes the QUIZ, not any visitor. ~18 rows for an
-- eight-step quiz, and it does not grow with traffic.
--
-- Keyed on quiz_variant alone. funnel_variant is the orthogonal presentation
-- axis and one definition serves many of them.
CREATE OR REPLACE FUNCTION public.cro_quiz_catalog(
  p_quiz_variant TEXT DEFAULT NULL
)
RETURNS TABLE (
  quiz_variant     TEXT,
  app_key          TEXT,
  funnel_key       TEXT,
  first_step_id    TEXT,
  total_steps      INTEGER,
  config_hash      TEXT,
  published_at     TIMESTAMPTZ,
  step_id          TEXT,
  step_position    INTEGER,
  sort_index       INTEGER,
  step_type        TEXT,
  phase_key        TEXT,
  store_as         TEXT,
  label            TEXT,
  is_question      BOOLEAN,
  is_terminal      BOOLEAN,
  is_unconditional BOOLEAN,
  entry_skippable  BOOLEAN,
  answer_keys      JSONB,
  option_values    JSONB,
  option_labels    JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $$
BEGIN
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT d.quiz_variant, d.app_key, d.funnel_key, d.first_step_id,
         d.total_steps, d.config_hash, d.published_at,
         st.step_id, st.position, st.sort_index, st.step_type, st.phase_key,
         st.store_as, st.label, st.is_question, st.is_terminal,
         st.is_unconditional, st.entry_skippable, st.answer_keys, st.option_values,
         st.option_labels
  FROM public.quiz_definitions d
  JOIN public.quiz_definition_steps st ON st.quiz_variant = d.quiz_variant
  WHERE (p_quiz_variant IS NULL OR d.quiz_variant = p_quiz_variant)
  ORDER BY d.quiz_variant, st.sort_index;
END;
$$;


-- ── cro_session_totals ──────────────────────────────────────────────────────
-- Top-line counts for the Overview tab. Parameter order mirrors
-- cro_step_funnel exactly so the app passes one filter object to both.
--
-- NO JSONB EXPANSION AT ALL. `no_activity` is an equality on the whole
-- document, not a walk of it.
--
-- It exists because cro_step_funnel cannot answer one Overview question: its
-- activity CTE skips `step_activity = '{}'`, so a session that bounced before
-- the first save, or whose quiz_variant was never published, contributes
-- nothing. `totals.entered` therefore UNDERCOUNTS starts, and without this
-- nothing says by how much. A high no_activity ratio is also the "the publisher
-- never ran for this variant" alarm.
CREATE OR REPLACE FUNCTION public.cro_session_totals(
  p_from            TIMESTAMPTZ,
  p_to              TIMESTAMPTZ,
  p_quiz_variant    TEXT     DEFAULT NULL,
  p_funnel_variant  TEXT     DEFAULT NULL,
  p_source          TEXT     DEFAULT NULL,
  p_settled_after   INTERVAL DEFAULT INTERVAL '2 hours',
  p_locale          TEXT     DEFAULT NULL
)
RETURNS TABLE (
  quiz_variant            TEXT,
  funnel_variant          TEXT,
  sessions                BIGINT,
  with_activity           BIGINT,
  no_activity             BIGINT,
  completed               BIGINT,
  abandoned_settled       BIGINT,
  unsettled               BIGINT,
  lead_captured           BIGINT,
  p50_seconds_to_complete DOUBLE PRECISION,
  p90_seconds_to_complete DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $$
BEGIN
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bounds AS (
    SELECT COALESCE(p_from, now() - INTERVAL '30 days')  AS lo,
           COALESCE(p_to,   now())                       AS hi,
           now() - COALESCE(p_settled_after, INTERVAL '0') AS settled_before
  ),
  scoped AS (
    SELECT s.quiz_variant, s.funnel_variant, s.status, s.email,
           s.step_activity, s.created_at, s.completed_at, s.updated_at
    FROM public.sessions s
    CROSS JOIN bounds b
    WHERE s.created_at >= b.lo
      AND s.created_at <  b.hi
      AND (p_quiz_variant   IS NULL OR s.quiz_variant   = p_quiz_variant)
      AND (p_funnel_variant IS NULL OR s.funnel_variant = p_funnel_variant)
      AND (p_source         IS NULL OR s.source         = p_source)
      AND (p_locale         IS NULL OR s.locale         = p_locale)
  )
  SELECT sc.quiz_variant,
         sc.funnel_variant,
         count(*)::BIGINT,
         count(*) FILTER (WHERE sc.step_activity <> '{}'::JSONB)::BIGINT,
         count(*) FILTER (WHERE sc.step_activity =  '{}'::JSONB)::BIGINT,
         count(*) FILTER (WHERE sc.status = 'completed')::BIGINT,
         count(*) FILTER (
           WHERE sc.status <> 'completed'
             AND sc.updated_at < (SELECT b.settled_before FROM bounds b)
         )::BIGINT,
         count(*) FILTER (
           WHERE sc.status <> 'completed'
             AND sc.updated_at >= (SELECT b.settled_before FROM bounds b)
         )::BIGINT,
         -- A COUNT of sessions that captured an address. Never the addresses.
         count(*) FILTER (WHERE sc.email IS NOT NULL)::BIGINT,
         -- sessions_completion_check guarantees completed_at is non-null exactly
         -- when status = 'completed', so percentile_cont's NULL-skipping is the
         -- filter; no FILTER clause needed.
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (sc.completed_at - sc.created_at))::DOUBLE PRECISION
         ),
         percentile_cont(0.9) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (sc.completed_at - sc.created_at))::DOUBLE PRECISION
         )
  FROM scoped sc
  GROUP BY 1, 2
  ORDER BY 1, 2;
END;
$$;


-- ── cro_live_sessions ───────────────────────────────────────────────────────
-- Who is mid-quiz right now, and on which screen.
--
-- THE STEP IS RESOLVED THROUGH THREE LEVELS, and the fallback is the whole
-- design. create_quiz_session does NOT set current_step_id — only
-- save_quiz_session_progress does — so keying on it alone silently drops every
-- visitor who landed and never saved. That is the largest bucket and the one
-- with the worst drop-off. step_basis says which level answered, so the tab can
-- be honest rather than quietly wrong.
--
-- WHAT DWELL MEANS HERE. save_quiz_session_progress sets current_step_id and
-- updated_at in the SAME update, and the client sends the step it is moving
-- INTO. So now() - updated_at is genuinely time-on-this-screen — sharper than
-- carnivore-app's "time since any event", which needs a DISTINCT ON to break
-- ties within a batch.
--
-- WHAT IT CANNOT SEE, and the tab must say so:
--   * Back-navigation. goBack() does not save, so someone who backed up two
--     screens still shows on the one they last moved FORWARD into, with a dwell
--     that keeps climbing. This is the one real regression against carnivore.
--   * A closed tab. There is no heartbeat and no beforeunload write, so a
--     12-minute dwell means "no forward move in 12 minutes", not "still here".
--     Do not label this "people online".
--   * status never becomes 'abandoned' on its own — nothing writes it. Filtering
--     status = 'active' means "not completed", not "still present".
CREATE OR REPLACE FUNCTION public.cro_live_sessions(
  p_window_minutes INTEGER DEFAULT 15,
  p_quiz_variant   TEXT DEFAULT NULL,
  p_funnel_variant TEXT DEFAULT NULL,
  p_locale         TEXT DEFAULT NULL,
  p_source         TEXT DEFAULT NULL
)
RETURNS TABLE (
  quiz_variant      TEXT,
  funnel_variant    TEXT,
  step_id           TEXT,
  step_position     INTEGER,
  sort_index        INTEGER,
  label             TEXT,
  is_question       BOOLEAN,
  in_catalog        BOOLEAN,
  step_basis        TEXT,
  active_sessions   BIGINT,
  p50_dwell_seconds DOUBLE PRECISION,
  p90_dwell_seconds DOUBLE PRECISION,
  max_dwell_seconds DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $$
BEGIN
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Bounded so "live" can never become a full scan behind an auto-refresh.
  IF p_window_minutes IS NULL OR p_window_minutes < 1 OR p_window_minutes > 240 THEN
    RAISE EXCEPTION 'p_window_minutes must be between 1 and 240'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH live AS (
    SELECT s.id, s.quiz_variant, s.funnel_variant, s.updated_at,
           COALESCE(s.current_step_id, lv.step_id, d.first_step_id) AS step_id,
           CASE
             WHEN s.current_step_id IS NOT NULL THEN 'current_step_id'
             WHEN lv.step_id        IS NOT NULL THEN 'last_viewed'
             ELSE 'landing'
           END AS step_basis
    FROM public.sessions s
    LEFT JOIN public.quiz_definitions d ON d.quiz_variant = s.quiz_variant
    -- The jsonb expansion is kept off the common path: it runs only for the
    -- minority whose current_step_id is still null.
    LEFT JOIN LATERAL (
      SELECT a.key AS step_id
      FROM jsonb_each(s.step_activity) AS a(key, value)
      ORDER BY (a.value ->> 'viewed_at')::TIMESTAMPTZ DESC NULLS LAST
      LIMIT 1
    ) lv ON s.current_step_id IS NULL
    WHERE s.status = 'active'
      AND s.updated_at >= now() - make_interval(mins => p_window_minutes)
      AND (p_quiz_variant   IS NULL OR s.quiz_variant   = p_quiz_variant)
      AND (p_funnel_variant IS NULL OR s.funnel_variant = p_funnel_variant)
      AND (p_locale         IS NULL OR s.locale         = p_locale)
      AND (p_source         IS NULL OR s.source         = p_source)
  )
  SELECT l.quiz_variant,
         l.funnel_variant,
         l.step_id,
         st.position,
         st.sort_index,
         st.label,
         COALESCE(st.is_question, false),
         (st.step_id IS NOT NULL),
         l.step_basis,
         count(*)::BIGINT,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (now() - l.updated_at))::DOUBLE PRECISION
         ),
         percentile_cont(0.9) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (now() - l.updated_at))::DOUBLE PRECISION
         ),
         max(EXTRACT(EPOCH FROM (now() - l.updated_at)))::DOUBLE PRECISION
  FROM live l
  LEFT JOIN public.quiz_definition_steps st
    ON st.quiz_variant = l.quiz_variant AND st.step_id = l.step_id
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
  ORDER BY 4 NULLS LAST, 5 NULLS LAST, 3;
END;
$$;


-- ── cro_answer_distribution ─────────────────────────────────────────────────
-- What people actually answered, per question.
--
-- ═══ THE PII BOUNDARY IS AN ALLOWLIST, AND IT HAS TO BE ════════════════════
-- `email` and `fullName` are DECLARED answer keys — step6.storeAs = 'email',
-- step5.fields[0].storeAs = 'fullName'. A naive per-value distribution would
-- publish every buyer's address and full name through the very function built
-- to keep them in. So values are emitted only for step types whose answers are
-- a closed vocabulary of codes; everything else returns ONE row with a count
-- and a NULL value, which still gives the tab a completion rate for the email
-- gate without a single address.
--
-- An allowlist rather than a denylist of ('email','fullName') because this is a
-- template: a denylist breaks silently the first time a product adds `phone`.
--
-- DRIVEN FROM THE CATALOG, never from jsonb_object_keys(quiz_answers).
-- Expanding the session document would walk every key a visitor ever wrote —
-- including free text and keys belonging to other steps — and would surface
-- answers the catalog never declared. Driving from answer_keys makes an
-- undeclared key invisible rather than wrong, and `undeclared_keys` counts them
-- so drift is still visible.
CREATE OR REPLACE FUNCTION public.cro_answer_distribution(
  p_from           TIMESTAMPTZ,
  p_to             TIMESTAMPTZ,
  p_quiz_variant   TEXT,
  p_step_id        TEXT    DEFAULT NULL,
  p_funnel_variant TEXT    DEFAULT NULL,
  p_source         TEXT    DEFAULT NULL,
  p_locale         TEXT    DEFAULT NULL,
  p_min_sessions   INTEGER DEFAULT 1
)
RETURNS TABLE (
  step_id           TEXT,
  step_position     INTEGER,
  sort_index        INTEGER,
  label             TEXT,
  step_type         TEXT,
  answer_key        TEXT,
  value_kind        TEXT,
  answer_value      TEXT,
  -- Resolved English copy for answer_value, or NULL when the option has none.
  -- NULL is the interesting case: an answer recorded under a code the published
  -- step no longer offers, which in_option_set also reports.
  answer_label      TEXT,
  in_option_set     BOOLEAN,
  sessions          BIGINT,
  answered_sessions BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
BEGIN
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- REQUIRED, not defaulted. answer_keys and the option vocabulary are
  -- per-variant, so blending two versions blends two vocabularies under one key
  -- name. cro_step_funnel can default this because it RETURNS quiz_variant and
  -- the assembler merges only within one; a distribution has no such escape.
  IF p_quiz_variant IS NULL THEN
    RAISE EXCEPTION 'p_quiz_variant is required: blending quiz versions blends answer vocabularies'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH bounds AS (
    SELECT COALESCE(p_from, now() - INTERVAL '30 days') AS lo,
           COALESCE(p_to,   now())                      AS hi
  ),
  scoped AS (
    SELECT s.id, s.quiz_answers
    FROM public.sessions s
    CROSS JOIN bounds b
    WHERE s.created_at >= b.lo
      AND s.created_at <  b.hi
      AND s.quiz_variant = p_quiz_variant
      AND (p_funnel_variant IS NULL OR s.funnel_variant = p_funnel_variant)
      AND (p_source         IS NULL OR s.source         = p_source)
      AND (p_locale         IS NULL OR s.locale         = p_locale)
      AND s.quiz_answers <> '{}'::JSONB
  ),
  keys AS (
    SELECT st.step_id, st.position, st.sort_index, st.label, st.step_type,
           st.option_values, st.option_labels,
           -- The allowlist. Closed-vocabulary types only.
           (st.step_type IN ('radio','picture_select','text_select','chip_select',
                             'multi_select','likert','slider','trial_price')) AS emits_values,
           k.value AS answer_key
    FROM public.quiz_definition_steps st
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_array_length(st.answer_keys) > 0 THEN st.answer_keys
           WHEN st.store_as IS NOT NULL THEN jsonb_build_array(st.store_as)
           ELSE '[]'::JSONB END
    ) AS k(value)
    WHERE st.quiz_variant = p_quiz_variant
      AND st.is_question
      AND (p_step_id IS NULL OR st.step_id = p_step_id)
  ),
  raw AS (
    SELECT k.step_id, k.position, k.sort_index, k.label, k.step_type,
           k.answer_key, k.emits_values, k.option_values, k.option_labels,
           sc.id, sc.quiz_answers -> k.answer_key AS v
    FROM keys k
    JOIN scoped sc ON sc.quiz_answers ? k.answer_key
  ),
  exploded AS (
    -- multi_select and friends: one row per chosen code.
    SELECT r.step_id, r.position, r.sort_index, r.label, r.step_type, r.answer_key,
           r.option_values, r.option_labels, r.id, 'array_member'::TEXT AS value_kind, e.value AS answer_value
    FROM raw r
    CROSS JOIN LATERAL jsonb_array_elements_text(r.v) AS e(value)
    WHERE r.emits_values AND jsonb_typeof(r.v) = 'array'
    UNION ALL
    -- #>> '{}' unwraps a JSON scalar to text. ::text would keep the quotes and
    -- every label in the chart would render as "female" rather than female.
    SELECT r.step_id, r.position, r.sort_index, r.label, r.step_type, r.answer_key,
           r.option_values, r.option_labels, r.id, 'scalar'::TEXT, r.v #>> '{}'
    FROM raw r
    WHERE r.emits_values AND jsonb_typeof(r.v) IN ('string','number','boolean')
    UNION ALL
    -- The PII path: counted, never read.
    SELECT r.step_id, r.position, r.sort_index, r.label, r.step_type, r.answer_key,
           r.option_values, r.option_labels, r.id, 'freeform'::TEXT, NULL
    FROM raw r
    WHERE NOT r.emits_values
  ),
  per_key AS (
    SELECT e.step_id, e.answer_key, count(DISTINCT e.id) AS answered_sessions
    FROM exploded e GROUP BY 1, 2
  )
  SELECT x.step_id, x.position, x.sort_index, x.label, x.step_type, x.answer_key,
         x.value_kind,
         x.answer_value,
         -- ->> on a missing key is NULL, which is exactly what an option
         -- published before this column existed should render as.
         CASE WHEN x.answer_value IS NULL THEN NULL
              ELSE x.option_labels ->> x.answer_value END,
         CASE WHEN x.answer_value IS NULL THEN NULL
              ELSE x.option_values ? x.answer_value END,
         count(DISTINCT x.id)::BIGINT,
         -- Per KEY, not per value: choosing three options is three value rows
         -- but one answered session. Getting this denominator wrong is the
         -- easiest way to publish percentages over 100.
         max(pk.answered_sessions)::BIGINT
  FROM exploded x
  JOIN per_key pk ON pk.step_id = x.step_id AND pk.answer_key = x.answer_key
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  HAVING count(DISTINCT x.id) >= GREATEST(COALESCE(p_min_sessions, 1), 1)
  ORDER BY 3, 6, 11 DESC, 8;
END;
$$;


-- ── cro_segment_breakdown ───────────────────────────────────────────────────
-- How far each market / device / country gets through the quiz.
--
-- ONE DIMENSION PER CALL, not a wide cross product. 15 locales x 4 devices x 40
-- countries is thousands of one-session cells — each a quasi-identifier, none a
-- readable chart. The tab makes a few cheap calls instead.
--
-- locale and client_context are NOT the same quality of data, and the tab
-- should not imply they are. sessions.locale is last-write-wins
-- (`locale = COALESCE(p_locale, locale)` on every save), so it means "the
-- language the session ENDED in". client_context is written once at create and
-- never updated, so device / country / browser are exact.
CREATE OR REPLACE FUNCTION public.cro_segment_breakdown(
  p_from           TIMESTAMPTZ,
  p_to             TIMESTAMPTZ,
  p_quiz_variant   TEXT    DEFAULT NULL,
  p_funnel_variant TEXT    DEFAULT NULL,
  p_source         TEXT    DEFAULT NULL,
  p_dimension      TEXT    DEFAULT 'locale',
  p_min_sessions   INTEGER DEFAULT 1
)
RETURNS TABLE (
  dimension           TEXT,
  bucket              TEXT,
  sessions            BIGINT,
  with_activity       BIGINT,
  completed           BIGINT,
  completion_pct      DOUBLE PRECISION,
  median_max_position DOUBLE PRECISION,
  p90_max_position    DOUBLE PRECISION,
  max_position_reached INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '45s'
AS $$
BEGIN
  IF NOT public.is_cro_analyst() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(p_dimension, '') NOT IN ('locale','device','country','browser','platform','source') THEN
    RAISE EXCEPTION 'p_dimension must be one of locale, device, country, browser, platform, source'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH bounds AS (
    SELECT COALESCE(p_from, now() - INTERVAL '30 days') AS lo,
           COALESCE(p_to,   now())                      AS hi
  ),
  scoped AS (
    -- client_context is read by NAMED KEY only. The document also holds
    -- ip_address, user_agent and city, and this function is the boundary that
    -- keeps them from an analyst with a valid JWT.
    --
    -- COALESCE(NULLIF(...)) buckets a missing value as 'unknown' rather than
    -- dropping the row: country is null on any deployment not behind Vercel or
    -- Cloudflare, and losing those sessions would read as "that market has no
    -- data" instead of "we cannot geolocate".
    SELECT s.id, s.status, s.quiz_variant, s.step_activity,
           CASE p_dimension
             WHEN 'locale'   THEN COALESCE(NULLIF(s.locale, ''), 'unknown')
             WHEN 'source'   THEN COALESCE(NULLIF(s.source, ''), 'unknown')
             WHEN 'device'   THEN COALESCE(NULLIF(s.client_context ->> 'device_type', ''), 'unknown')
             WHEN 'country'  THEN COALESCE(NULLIF(s.client_context ->> 'country', ''), 'unknown')
             WHEN 'browser'  THEN COALESCE(NULLIF(s.client_context ->> 'browser', ''), 'unknown')
             WHEN 'platform' THEN COALESCE(NULLIF(s.client_context ->> 'platform', ''), 'unknown')
           END AS bucket
    FROM public.sessions s
    CROSS JOIN bounds b
    WHERE s.created_at >= b.lo
      AND s.created_at <  b.hi
      AND (p_quiz_variant   IS NULL OR s.quiz_variant   = p_quiz_variant)
      AND (p_funnel_variant IS NULL OR s.funnel_variant = p_funnel_variant)
      AND (p_source         IS NULL OR s.source         = p_source)
  ),
  depth AS (
    -- jsonb_object_keys, not jsonb_each: depth needs the keys only, and
    -- jsonb_each would materialise every value document for nothing.
    --
    -- LEFT JOIN LATERAL ... ON true, not CROSS JOIN: a session with
    -- step_activity = '{}' survives with max_position 0 instead of vanishing.
    -- That is the difference between "37% of Safari users never got past the
    -- landing" and "Safari has no data".
    SELECT sc.id, sc.bucket, sc.status, sc.step_activity,
           COALESCE(max(st.position), 0) AS max_position
    FROM scoped sc
    LEFT JOIN LATERAL jsonb_object_keys(sc.step_activity) AS a(step_id) ON true
    LEFT JOIN public.quiz_definition_steps st
      ON st.quiz_variant = sc.quiz_variant AND st.step_id = a.step_id
    GROUP BY 1, 2, 3, 4
  )
  SELECT p_dimension,
         d.bucket,
         count(*)::BIGINT,
         count(*) FILTER (WHERE d.step_activity <> '{}'::JSONB)::BIGINT,
         count(*) FILTER (WHERE d.status = 'completed')::BIGINT,
         CASE WHEN count(*) > 0
              THEN round((count(*) FILTER (WHERE d.status = 'completed')::NUMERIC
                          / count(*)::NUMERIC) * 100, 1)::DOUBLE PRECISION
              ELSE 0 END,
         -- DOUBLE PRECISION, not ::INTEGER. percentile_cont interpolates, so a
         -- group stopping at positions 3 and 4 has a true median of 3.5 —
         -- carnivore-app casts to INTEGER and silently reports 3, which across
         -- seven positions is 14% of the funnel.
         percentile_cont(0.5) WITHIN GROUP (ORDER BY d.max_position::DOUBLE PRECISION),
         percentile_cont(0.9) WITHIN GROUP (ORDER BY d.max_position::DOUBLE PRECISION),
         max(d.max_position)::INTEGER
  FROM depth d
  GROUP BY 1, 2
  HAVING count(*) >= GREATEST(COALESCE(p_min_sessions, 1), 1)
  ORDER BY 3 DESC, 2;
END;
$$;


-- The live tab polls; idx_sessions_quiz_reporting leads on created_at and is no
-- help. Without this an auto-refreshing board seq-scans sessions every few
-- seconds, which is the single largest cost in the dashboard.
CREATE INDEX IF NOT EXISTS idx_sessions_cro_live
  ON public.sessions (updated_at DESC) WHERE status = 'active';


-- Grants for the five. Same shape as the two above: EXECUTE to authenticated is
-- not the boundary, the is_cro_analyst() guard inside each one is.
REVOKE ALL ON FUNCTION public.cro_quiz_catalog(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cro_session_totals(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTERVAL, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cro_live_sessions(INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cro_answer_distribution(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cro_segment_breakdown(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.cro_quiz_catalog(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cro_session_totals(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTERVAL, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cro_live_sessions(INTEGER, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cro_answer_distribution(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cro_segment_breakdown(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated, service_role;
-- ── otp_attempts ────────────────────────────────────────────────────────────
-- Brute-force rate-limit ledger for verify-otp. service_role only.
CREATE TABLE IF NOT EXISTS public.otp_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  ip_address TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_attempts_email_time
  ON public.otp_attempts (email, attempted_at DESC);

ALTER TABLE public.otp_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.otp_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.otp_attempts TO service_role;


-- ── user_prefs ──────────────────────────────────────────────────────────────
-- Per-user UI preferences, created lazily on first PATCH from the member area.
-- The proxy hydrates the locale cookie from this table on every authenticated
-- request, so the database wins over a stale cookie.
CREATE TABLE IF NOT EXISTS public.user_prefs (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,               -- BCP-47, must match routing.locales
  country TEXT,                       -- ISO 3166-1 alpha-2, nullable
  app_open_count INTEGER NOT NULL DEFAULT 0,
  last_active_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own prefs" ON public.user_prefs;
CREATE POLICY "Users read own prefs"
  ON public.user_prefs FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users insert own prefs" ON public.user_prefs;
CREATE POLICY "Users insert own prefs"
  ON public.user_prefs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users update own prefs" ON public.user_prefs;
CREATE POLICY "Users update own prefs"
  ON public.user_prefs FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ── generation_locks ────────────────────────────────────────────────────────
-- Generic single-flight gate for expensive server work (AI calls, report
-- builds). Acquire = INSERT ... ON CONFLICT DO NOTHING, the inserter wins.
-- Release = DELETE. An expired row acts like no lock, so a crashed request
-- cannot wedge the key forever. Consumed by packages/shared/generation-lock.ts.
CREATE TABLE IF NOT EXISTS public.generation_locks (
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_generation_locks_expires_at
  ON public.generation_locks (expires_at);

ALTER TABLE public.generation_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_locks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.generation_locks TO service_role;


-- ── cron_runs ───────────────────────────────────────────────────────────────
-- One row per scheduled-job run, success or failure. Scheduled work here is
-- Vercel Cron hitting a Next.js route (there is no pg_cron), and a cron route
-- that returns `{ ok: false }` is read by nothing — this table is what makes a
-- failing or silently-stopped job visible:
--   select * from cron_runs where ok = false order by ran_at desc;
-- A gap in ran_at for a job means that job stopped running at all.
CREATE TABLE IF NOT EXISTS public.cron_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok BOOLEAN NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  generated INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  failures JSONB NOT NULL DEFAULT '[]'::JSONB,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_ran_at ON public.cron_runs (job, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_failed ON public.cron_runs (ran_at DESC) WHERE ok = false;

ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cron_runs TO service_role;


-- ── deletion_requests ───────────────────────────────────────────────────────
-- GDPR Article 17 audit trail: what was deleted, when, and whether it worked.
-- Shipped as scaffolding — the boilerplate has no delete-account route yet, so
-- nothing writes here until you add one. Drop the table if you never will.
CREATE TABLE IF NOT EXISTS public.deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  tables_affected JSONB DEFAULT '{}'::JSONB,
  error_details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deletion_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.deletion_requests TO service_role;


-- ── orders ──────────────────────────────────────────────────────────────────
-- Every payment attempt, funnel or member-area. Writes are service_role only;
-- the invariants below are enforced by CHECKs plus four BEFORE triggers
-- (section 6), because a webhook and an API route can both touch the same row
-- concurrently.
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  order_sequence INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'eur',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'completed', 'failed', 'refunded', 'disputed',
    'trialing', 'active', 'past_due', 'canceled'
  )),
  product_name TEXT NOT NULL,
  product_slug TEXT,

  psp TEXT NOT NULL DEFAULT 'solidgate',
  payment_environment TEXT NOT NULL DEFAULT 'production',

  solidgate_order_id TEXT,
  solidgate_subscription_id TEXT,
  solidgate_original_amount_cents INTEGER,
  solidgate_refunded_amount_cents INTEGER NOT NULL DEFAULT 0,
  solidgate_payment_status TEXT,
  solidgate_chargeback_id TEXT,
  solidgate_chargeback_status TEXT,
  solidgate_chargeback_amount_cents INTEGER NOT NULL DEFAULT 0,
  solidgate_pre_dispute_status TEXT,

  -- 3DS: the provider hands back a verify URL the browser must visit. It is
  -- stored so a reload or a second tab resumes the same authentication instead
  -- of opening a second order.
  solidgate_verify_url TEXT,
  solidgate_submission_token UUID,
  solidgate_submission_started_at TIMESTAMPTZ,

  -- Immutable checkout identity snapshot, bound when the order is opened.
  solidgate_customer_email TEXT,
  solidgate_checkout_locale TEXT,
  solidgate_product_id TEXT,
  solidgate_payment_action TEXT,
  solidgate_checkout_identity_bound_at TIMESTAMPTZ,
  solidgate_checkout_identity_legacy BOOLEAN NOT NULL DEFAULT FALSE,

  solidgate_card_source_sequence BIGINT NOT NULL
    DEFAULT nextval('public.solidgate_card_source_sequence'),

  tracking_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  analytics_captured_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT orders_payment_environment_check
    CHECK (payment_environment IN ('production', 'sandbox')),
  CONSTRAINT orders_solidgate_refunded_amount_check
    CHECK (solidgate_refunded_amount_cents >= 0),
  CONSTRAINT orders_solidgate_chargeback_amount_check
    CHECK (solidgate_chargeback_amount_cents >= 0),

  -- Either the row predates the identity snapshot (legacy, all five columns
  -- NULL and awaiting operator reconciliation) or it carries a complete,
  -- normalized snapshot. There is no third state.
  CONSTRAINT orders_solidgate_checkout_identity_check CHECK (
    psp IS DISTINCT FROM 'solidgate'
    OR (
      solidgate_checkout_identity_legacy
      AND solidgate_customer_email IS NULL
      AND solidgate_checkout_locale IS NULL
      AND solidgate_product_id IS NULL
      AND solidgate_payment_action IS NULL
      AND solidgate_checkout_identity_bound_at IS NULL
    )
    OR (
      NOT solidgate_checkout_identity_legacy
      AND solidgate_customer_email IS NOT NULL
      AND solidgate_customer_email = LOWER(BTRIM(solidgate_customer_email))
      AND CHAR_LENGTH(solidgate_customer_email) BETWEEN 3 AND 320
      AND solidgate_customer_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      -- Must stay in sync with packages/i18n routing.locales.
      AND solidgate_checkout_locale IN (
        'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
        'he', 'pl', 'hr', 'da', 'ja'
      )
      AND solidgate_payment_action IN ('auth_settle', 'auth_0_amount')
      AND solidgate_checkout_identity_bound_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_orders_session_id ON public.orders (session_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS orders_solidgate_order_id_key
  ON public.orders (payment_environment, solidgate_order_id)
  WHERE solidgate_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_solidgate_subscription_id_key
  ON public.orders (payment_environment, solidgate_subscription_id)
  WHERE solidgate_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_solidgate_oto_open
  ON public.orders (
    payment_environment, session_id, product_slug, created_at DESC, id DESC
  )
  WHERE psp = 'solidgate' AND session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_solidgate_pwa_open
  ON public.orders (payment_environment, user_id, product_slug, created_at, id)
  WHERE psp = 'solidgate' AND session_id IS NULL AND user_id IS NOT NULL;

-- One live order per (environment, session, OTO step). This is an EXPRESSION
-- index over the product-catalog resolver, so changing
-- solidgate_oto_step_from_product_slug() silently invalidates it — REINDEX
-- after any catalog edit, or the "one payable order per funnel step"
-- guarantee quietly disappears. A hard-zero terminal failure is excluded so a
-- declined attempt does not block the retry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_solidgate_one_live_oto_step
  ON public.orders (
    payment_environment,
    session_id,
    (public.solidgate_oto_step_from_product_slug(product_slug))
  )
  WHERE psp = 'solidgate'
    AND session_id IS NOT NULL
    AND public.solidgate_oto_step_from_product_slug(product_slug) IS NOT NULL
    AND (
      status IS DISTINCT FROM 'failed'
      OR amount_cents IS DISTINCT FROM 0
      OR solidgate_payment_status IS NULL
      OR solidgate_payment_status
           NOT IN ('auth_failed', 'declined', 'void_ok', 'request_rejected')
    );

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read their own orders" ON public.orders;
CREATE POLICY "Authenticated users can read their own orders"
  ON public.orders FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON COLUMN public.orders.tracking_metadata IS
  'Server-sanitized checkout/product/UTM metadata mirrored into the provider order_metadata.';
COMMENT ON COLUMN public.orders.solidgate_customer_email IS
  'Normalized checkout email sent to the provider; immutable order-level snapshot.';
COMMENT ON COLUMN public.orders.solidgate_checkout_identity_legacy IS
  'True only for pre-snapshot orders awaiting provider-evidence reconciliation.';


-- ── entitlements ────────────────────────────────────────────────────────────
-- Single source of truth for what a user may access. One row per
-- (environment, user, product_slug).
CREATE TABLE IF NOT EXISTS public.entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_slug TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'full',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'canceled')),
  payment_environment TEXT NOT NULL DEFAULT 'production'
    CHECK (payment_environment IN ('production', 'sandbox')),
  solidgate_subscription_id TEXT,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_user_product
  ON public.entitlements (payment_environment, user_id, product_slug);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_id ON public.entitlements (user_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_status_expires
  ON public.entitlements (user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_entitlements_solidgate_sub
  ON public.entitlements (payment_environment, solidgate_subscription_id)
  WHERE solidgate_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entitlements_payment_environment_order_id
  ON public.entitlements (payment_environment, order_id)
  WHERE order_id IS NOT NULL;

ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read their own entitlements" ON public.entitlements;
CREATE POLICY "Authenticated users can read their own entitlements"
  ON public.entitlements FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ── renewal_events ──────────────────────────────────────────────────────────
-- Recurring-revenue ledger, one row per provider invoice.
--
-- SECURITY: this table was once created without RLS. Supabase grants anon and
-- authenticated full table privileges by default, so the anon key — which
-- ships in every browser — could SELECT the entire revenue ledger and INSERT
-- forged rows through PostgREST (reproduced locally: anon POST returned 201).
-- RLS + zero policies default-denies both roles; the webhook writes with the
-- service-role key, which bypasses RLS.
CREATE TABLE IF NOT EXISTS public.renewal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_environment TEXT NOT NULL DEFAULT 'production'
    CHECK (payment_environment IN ('production', 'sandbox')),
  solidgate_invoice_id TEXT,
  solidgate_subscription_id TEXT,
  solidgate_order_id TEXT,
  subscription_term_number INTEGER,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  gross_amount_cents INTEGER,
  refunded_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  currency TEXT NOT NULL,
  product_key TEXT,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN (
    'paid', 'partially_refunded', 'refunded', 'disputed',
    'chargeback_reversed', 'voided'
  )),
  chargeback_id TEXT,
  chargeback_status TEXT,
  chargeback_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (chargeback_amount_cents >= 0),
  invoice_created_at TIMESTAMPTZ,
  event_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A NULL invoice id would insert silently, and because unique indexes treat
  -- NULLs as distinct, ON CONFLICT would never fire: every webhook redelivery
  -- would append another row and inflate renewal revenue. Fail loudly instead.
  CONSTRAINT renewal_events_one_psp_invoice_id CHECK (solidgate_invoice_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS renewal_events_created_at_idx
  ON public.renewal_events (created_at);
CREATE INDEX IF NOT EXISTS renewal_events_solidgate_subscription_idx
  ON public.renewal_events (solidgate_subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS renewal_events_solidgate_invoice_key
  ON public.renewal_events (payment_environment, solidgate_invoice_id)
  WHERE solidgate_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS renewal_events_solidgate_order_key
  ON public.renewal_events (payment_environment, solidgate_order_id)
  WHERE solidgate_order_id IS NOT NULL;

ALTER TABLE public.renewal_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.renewal_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.renewal_events TO service_role;


-- ── user_acquisition_attribution ────────────────────────────────────────────
-- First-touch UTM attribution captured from the first linked provider order.
CREATE TABLE IF NOT EXISTS public.user_acquisition_attribution (
  payment_environment TEXT NOT NULL
    CHECK (payment_environment IN ('production', 'sandbox')),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  source_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, user_id),
  CONSTRAINT user_acquisition_has_utm CHECK (
    COALESCE(
      NULLIF(utm_source, ''), NULLIF(utm_medium, ''), NULLIF(utm_campaign, ''),
      NULLIF(utm_content, ''), NULLIF(utm_term, '')
    ) IS NOT NULL
  ),
  CONSTRAINT user_acquisition_utm_length CHECK (
    COALESCE(char_length(utm_source), 0) <= 380
    AND COALESCE(char_length(utm_medium), 0) <= 380
    AND COALESCE(char_length(utm_campaign), 0) <= 380
    AND COALESCE(char_length(utm_content), 0) <= 380
    AND COALESCE(char_length(utm_term), 0) <= 380
  )
);

ALTER TABLE public.user_acquisition_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_acquisition_attribution FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_acquisition_attribution TO service_role;

COMMENT ON TABLE public.user_acquisition_attribution IS
  'Environment-scoped first-touch UTM attribution from the first linked provider order.';


-- ── meta_capi_event_claims ──────────────────────────────────────────────────
-- Server-side conversions API ingress guard: dedupes event_id and rate-limits
-- per hashed IP. NOTE the environment vocabulary here is the *deployment*
-- environment (production/preview/development), not payment_environment.
CREATE TABLE IF NOT EXISTS public.meta_capi_event_claims (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  environment TEXT NOT NULL
    CHECK (environment IN ('production', 'preview', 'development')),
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, event_name, event_id)
);

CREATE INDEX IF NOT EXISTS meta_capi_event_claims_ip_window_idx
  ON public.meta_capi_event_claims (environment, ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS meta_capi_event_claims_retention_idx
  ON public.meta_capi_event_claims (created_at);

ALTER TABLE public.meta_capi_event_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_capi_event_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.meta_capi_event_claims TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. SOLIDGATE MACHINERY TABLES
--
-- Every table below is service_role only: RLS enabled, zero policies, plus an
-- explicit REVOKE from anon/authenticated.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── solidgate_webhook_events ────────────────────────────────────────────────
-- Idempotency + claim fence for the webhook. The provider does NOT guarantee
-- delivery order and duplicates do occur, so event_created_at drives the
-- stale-event guard and (claim_token, claim_generation) makes completion
-- fenced: a slow worker whose lease expired cannot complete an event that a
-- newer worker has since re-claimed.
CREATE TABLE IF NOT EXISTS public.solidgate_webhook_events (
  environment TEXT NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'sandbox')),
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  event_created_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  payload JSONB,
  claim_token UUID,
  claim_generation BIGINT NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, event_id),
  CONSTRAINT solidgate_webhook_events_terminal_claim_check
    CHECK (status = 'processing' OR claim_token IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_solidgate_webhook_events_received_at
  ON public.solidgate_webhook_events (received_at);
CREATE INDEX IF NOT EXISTS idx_solidgate_webhook_events_retry
  ON public.solidgate_webhook_events (status, processing_started_at)
  WHERE status IN ('processing', 'failed');
CREATE INDEX IF NOT EXISTS idx_solidgate_webhook_events_active_claim
  ON public.solidgate_webhook_events (environment, event_id, claim_generation)
  WHERE status = 'processing' AND claim_token IS NOT NULL;

ALTER TABLE public.solidgate_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.solidgate_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.solidgate_webhook_events TO service_role;


-- ── solidgate_entity_watermarks ─────────────────────────────────────────────
-- Serializes callbacks per entity (subscription, order) so two events for the
-- same entity never interleave. Only a strictly older provider timestamp is
-- stale: event IDs are opaque, so equal timestamps must both be processed.
CREATE TABLE IF NOT EXISTS public.solidgate_entity_watermarks (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  last_event_created_at TIMESTAMPTZ,
  last_event_id TEXT,
  processing_event_created_at TIMESTAMPTZ,
  processing_event_id TEXT,
  processing_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

ALTER TABLE public.solidgate_entity_watermarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_entity_watermarks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_entity_watermarks TO service_role;


-- ── solidgate_invoice_orders ────────────────────────────────────────────────
-- Mirror of provider invoice-order rows; the join table between a subscription
-- invoice and the individual charge attempts inside it.
CREATE TABLE IF NOT EXISTS public.solidgate_invoice_orders (
  environment TEXT NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'sandbox')),
  solidgate_order_id TEXT NOT NULL,
  solidgate_invoice_id TEXT NOT NULL,
  solidgate_subscription_id TEXT NOT NULL,
  subscription_term_number INTEGER,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  operation TEXT,
  product_price_id TEXT,
  order_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  refunded_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  chargeback_id TEXT,
  chargeback_status TEXT,
  chargeback_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (chargeback_amount_cents >= 0),
  source_created_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  event_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, solidgate_order_id)
);

CREATE INDEX IF NOT EXISTS idx_solidgate_invoice_orders_invoice
  ON public.solidgate_invoice_orders (environment, solidgate_invoice_id);
CREATE INDEX IF NOT EXISTS idx_solidgate_invoice_orders_subscription
  ON public.solidgate_invoice_orders (environment, solidgate_subscription_id);

ALTER TABLE public.solidgate_invoice_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_invoice_orders FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_invoice_orders TO service_role;


-- ── solidgate_analytics_outbox ──────────────────────────────────────────────
-- At-least-once analytics delivery. insert_id is the downstream dedupe key,
-- event_key the local one, so a retried webhook cannot double-count revenue.
CREATE TABLE IF NOT EXISTS public.solidgate_analytics_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'sandbox')),
  event_key TEXT NOT NULL,
  event_name TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  insert_id UUID NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processing_started_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS solidgate_analytics_outbox_environment_event_key
  ON public.solidgate_analytics_outbox (environment, event_key);
CREATE UNIQUE INDEX IF NOT EXISTS solidgate_analytics_outbox_environment_insert_id
  ON public.solidgate_analytics_outbox (environment, insert_id);
CREATE INDEX IF NOT EXISTS idx_solidgate_analytics_outbox_delivery
  ON public.solidgate_analytics_outbox (environment, next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed', 'processing');

ALTER TABLE public.solidgate_analytics_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_analytics_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_analytics_outbox TO service_role;


-- ── solidgate_fulfillment_outbox ────────────────────────────────────────────
-- Durable post-purchase side effects, drained by the app-side worker in
-- apps/funnel/src/lib/payment/solidgate-fulfillment.ts.
--
-- ADDING AN EFFECT: extend the effect_type CHECK below *and* add a handler in
-- that worker. A row whose effect_type has no handler is claimed, fails, and
-- eventually lands in 'manual_review'.
CREATE TABLE IF NOT EXISTS public.solidgate_fulfillment_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL
    CHECK (environment IN ('production', 'sandbox')),
  solidgate_order_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token UUID,
  processing_started_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'processing') = (claim_token IS NOT NULL)),
  UNIQUE (environment, solidgate_order_id, effect_key)
);

ALTER TABLE public.solidgate_fulfillment_outbox
  DROP CONSTRAINT IF EXISTS solidgate_fulfillment_outbox_effect_type_check;
ALTER TABLE public.solidgate_fulfillment_outbox
  ADD CONSTRAINT solidgate_fulfillment_outbox_effect_type_check
  CHECK (effect_type IN (
    'cancel_main_subscription',
    'send_welcome_email',
    'enrich_main_profile',
    'send_meta_capi_purchase'
  ));

CREATE INDEX IF NOT EXISTS idx_solidgate_fulfillment_outbox_delivery
  ON public.solidgate_fulfillment_outbox (environment, next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed', 'processing');

ALTER TABLE public.solidgate_fulfillment_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_fulfillment_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_fulfillment_outbox TO service_role;


-- ── solidgate_intro_claims ──────────────────────────────────────────────────
-- One introductory offer per buyer email, leased while checkout is in flight.
-- If a buyer somehow gets charged twice, the extra subscription ids land in
-- superseded_subscription_ids and surface in the refund view below — access is
-- still granted (never punish the buyer), but an operator must refund.
CREATE TABLE IF NOT EXISTS public.solidgate_intro_claims (
  payment_environment TEXT NOT NULL
    CHECK (payment_environment IN ('production', 'sandbox')),
  email_hash TEXT NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  -- PRODUCT CATALOG: the intro tier vocabulary. Keep in sync with the
  -- offer_slug CHECK on solidgate_main_checkout_states and with
  -- solidgate_main_checkout_amount() in section 2.
  tier TEXT NOT NULL CHECK (tier IN (
    'trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free'
  )),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'consumed')),
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '60 minutes'),
  solidgate_subscription_id TEXT,
  superseded_subscription_ids TEXT[] NOT NULL DEFAULT '{}',
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, email_hash)
);

CREATE INDEX IF NOT EXISTS solidgate_intro_claims_session_idx
  ON public.solidgate_intro_claims (payment_environment, session_id);
CREATE UNIQUE INDEX IF NOT EXISTS solidgate_intro_claims_subscription_idx
  ON public.solidgate_intro_claims (payment_environment, solidgate_subscription_id)
  WHERE solidgate_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS solidgate_intro_claims_superseded_idx
  ON public.solidgate_intro_claims (payment_environment)
  WHERE cardinality(superseded_subscription_ids) > 0;
CREATE INDEX IF NOT EXISTS solidgate_intro_claims_pending_lease_idx
  ON public.solidgate_intro_claims (payment_environment, lease_expires_at)
  WHERE state = 'pending';

ALTER TABLE public.solidgate_intro_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_intro_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_intro_claims TO service_role;

COMMENT ON COLUMN public.solidgate_intro_claims.superseded_subscription_ids IS
  'Extra provider subscription IDs charged to this buyer after the claim was consumed. Non-empty = a real double subscription that was granted anyway and needs a refund.';


-- ── solidgate_session_vault ─────────────────────────────────────────────────
-- Funnel saved-card vault powering the OTO one-click chain, plus the
-- "pay with •••• 4242" UI (brand/last4 captured from the charge payload, so no
-- extra provider round-trip).
--
-- Deliberately NOT columns on `sessions`: that table grants anon INSERT and
-- authenticated UPDATE of one's own row, and Supabase's table-wide grants mean
-- a column-level REVOKE cannot claw those back (verified — a column REVOKE
-- left an anon-planted card token persisting). A separate table with RLS on and
-- zero policies is default-denied to every client role.
CREATE TABLE IF NOT EXISTS public.solidgate_session_vault (
  payment_environment TEXT NOT NULL DEFAULT 'production'
    CHECK (payment_environment IN ('production', 'sandbox')),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  customer_account_id TEXT NOT NULL,
  card_token TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_original_payment_method TEXT,
  card_source_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  card_source_created_at TIMESTAMPTZ,
  card_source_sequence BIGINT,
  card_source_legacy BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, session_id),

  CONSTRAINT solidgate_session_vault_card_source_check CHECK (
    (
      card_token IS NULL
      AND card_source_order_id IS NULL
      AND card_source_created_at IS NULL
      AND card_source_sequence IS NULL
    )
    OR (
      card_token IS NOT NULL
      AND card_source_legacy
      AND card_source_order_id IS NULL
      AND card_source_created_at IS NULL
      AND card_source_sequence IS NULL
    )
    OR (
      NOT card_source_legacy
      AND card_source_order_id IS NOT NULL
      AND card_source_created_at IS NOT NULL
      AND card_source_sequence IS NOT NULL
    )
  ),

  -- click-to-pay is observational only: the provider returns it but the token
  -- is not reusable for a merchant-initiated charge.
  CONSTRAINT solidgate_session_vault_original_payment_method_check CHECK (
    card_original_payment_method IS NULL
    OR (
      NULLIF(BTRIM(card_token), '') IS NOT NULL
      AND card_original_payment_method IN (
        'card', 'apple-pay', 'google-pay', 'network-token', 'click-to-pay'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_solidgate_session_vault_customer
  ON public.solidgate_session_vault (customer_account_id);

ALTER TABLE public.solidgate_session_vault ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_session_vault FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_session_vault TO service_role;


-- ── solidgate_account_vault ─────────────────────────────────────────────────
-- Account-scoped card vault for member-area billing. card_source_sequence
-- makes vault writes monotonic: an older card source can never overwrite a
-- newer one, even if its webhook arrives late.
CREATE TABLE IF NOT EXISTS public.solidgate_account_vault (
  payment_environment TEXT NOT NULL DEFAULT 'production'
    CHECK (payment_environment IN ('production', 'sandbox')),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_account_id TEXT NOT NULL,
  card_token TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_original_payment_method TEXT,
  card_source_kind TEXT NOT NULL DEFAULT 'legacy',
  card_source_created_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity'::TIMESTAMPTZ,
  card_source_sequence BIGINT NOT NULL DEFAULT 0,
  card_source_id TEXT NOT NULL DEFAULT 'legacy',
  session_origin_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, user_id),

  CONSTRAINT solidgate_account_vault_card_source_kind_check CHECK (
    card_source_kind IN ('legacy', 'main_order', 'pwa_order', 'card_update')
  ),
  CONSTRAINT solidgate_account_vault_original_payment_method_check CHECK (
    card_original_payment_method IS NULL
    OR (
      NULLIF(BTRIM(card_token), '') IS NOT NULL
      AND card_original_payment_method IN (
        'card', 'apple-pay', 'google-pay', 'network-token', 'click-to-pay'
      )
    )
  )
);

ALTER TABLE public.solidgate_account_vault ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_account_vault FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.solidgate_account_vault TO service_role;


-- ── solidgate_main_checkout_states ──────────────────────────────────────────
-- One in-flight main checkout per (environment, session, product). builder_token
-- fences the hosted-form build so two tabs cannot each mint a payment intent.
CREATE TABLE IF NOT EXISTS public.solidgate_main_checkout_states (
  payment_environment TEXT NOT NULL
    CHECK (payment_environment IN ('production', 'sandbox')),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  -- PRODUCT CATALOG: the single main-subscription offering code. Rename it
  -- here and in section 2 together — guard_solidgate_main_payable_order()
  -- asserts the same literal.
  product_slug TEXT NOT NULL CHECK (product_slug = 'BRAND_000000_SUB'),
  -- PRODUCT CATALOG: intro tiers. Keep in sync with solidgate_intro_claims.tier.
  offer_slug TEXT NOT NULL CHECK (offer_slug IN (
    'trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free'
  )),
  order_db_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  builder_token UUID NOT NULL,
  build_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  merchant_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, session_id, product_slug),
  UNIQUE (order_db_id),
  CHECK (merchant_data IS NULL OR jsonb_typeof(merchant_data) = 'object')
);

ALTER TABLE public.solidgate_main_checkout_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_main_checkout_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.solidgate_main_checkout_states TO service_role;


-- ── solidgate_pwa_purchase_states ───────────────────────────────────────────
-- Member-area purchase identity, mode, lease fence and hosted-form cache.
CREATE TABLE IF NOT EXISTS public.solidgate_pwa_purchase_states (
  payment_environment TEXT NOT NULL
    CHECK (payment_environment IN ('production', 'sandbox')),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_slug TEXT NOT NULL,
  offer_slug TEXT NOT NULL,
  order_db_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  purchase_mode TEXT NOT NULL CHECK (purchase_mode IN ('saved_card', 'hosted_form')),
  claim_token UUID NOT NULL,
  claim_kind TEXT CHECK (claim_kind IN ('build_form', 'submit_card', 'reconcile')),
  claim_started_at TIMESTAMPTZ,
  merchant_data JSONB,
  last_result_kind TEXT CHECK (last_result_kind IN (
    'pending', 'requires_action', 'captured', 'terminal_failure'
  )),
  last_result_net_amount_cents INTEGER,
  last_result_subscription_id TEXT,
  last_result_verify_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, user_id, product_slug),
  UNIQUE (order_db_id),
  CHECK ((claim_kind IS NULL) = (claim_started_at IS NULL)),
  CHECK (merchant_data IS NULL OR jsonb_typeof(merchant_data) = 'object'),
  CHECK (last_result_net_amount_cents IS NULL OR last_result_net_amount_cents >= 0)
);

ALTER TABLE public.solidgate_pwa_purchase_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_pwa_purchase_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.solidgate_pwa_purchase_states TO service_role;

COMMENT ON TABLE public.solidgate_pwa_purchase_states IS
  'Current idempotent member-area purchase identity, mode, lease fence, and hosted-form cache.';


-- ── solidgate_card_update_attempts ──────────────────────────────────────────
-- Zero-auth card-replacement ledger. `is_current` + the partial unique index
-- guarantee exactly one live attempt per user, so an old return URL cannot
-- repoint a subscription at a card the buyer already replaced.
CREATE TABLE IF NOT EXISTS public.solidgate_card_update_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_sequence BIGINT NOT NULL
    DEFAULT nextval('public.solidgate_card_source_sequence'),
  payment_environment TEXT NOT NULL
    CHECK (payment_environment IN ('production', 'sandbox')),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  solidgate_order_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  checkout_locale TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('building', 'issued', 'applying', 'completed', 'failed')),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  builder_token UUID,
  builder_started_at TIMESTAMPTZ,
  merchant_data JSONB,
  apply_token UUID,
  apply_started_at TIMESTAMPTZ,
  last_provider_status TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_environment, solidgate_order_id),
  CHECK (customer_email = LOWER(BTRIM(customer_email))),
  CHECK (CHAR_LENGTH(customer_email) BETWEEN 3 AND 320),
  CHECK (customer_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  -- Must stay in sync with packages/i18n routing.locales.
  CHECK (checkout_locale IN (
    'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
    'he', 'pl', 'hr', 'da', 'ja'
  )),
  CHECK ((builder_token IS NULL) = (builder_started_at IS NULL)),
  CHECK ((apply_token IS NULL) = (apply_started_at IS NULL)),
  CHECK (merchant_data IS NULL OR jsonb_typeof(merchant_data) = 'object'),
  CHECK ((state = 'building') = (merchant_data IS NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS solidgate_card_update_one_current
  ON public.solidgate_card_update_attempts (payment_environment, user_id)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS solidgate_card_update_user_history
  ON public.solidgate_card_update_attempts (
    payment_environment, user_id, created_at DESC, id DESC
  );

-- Reached only through the SECURITY DEFINER RPCs in section 7: even
-- service_role cannot write this table directly.
ALTER TABLE public.solidgate_card_update_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_card_update_attempts
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.solidgate_card_update_attempts IS
  'Durable newest-attempt and consume ledger for zero-auth card replacement; old return URLs cannot repoint subscriptions.';


-- ── solidgate_subscription_token_sync_jobs ──────────────────────────────────
-- Claim-fenced outbox that eventually points each billable subscription at the
-- current proven account-vault token. 'awaiting_token' is the state for a
-- subscription whose desired source has no reusable token yet.
CREATE TABLE IF NOT EXISTS public.solidgate_subscription_token_sync_jobs (
  payment_environment TEXT NOT NULL
    CHECK (payment_environment IN ('production', 'sandbox')),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  solidgate_subscription_id TEXT NOT NULL,
  desired_source_kind TEXT NOT NULL
    CHECK (desired_source_kind IN ('main_order', 'pwa_order', 'card_update')),
  desired_source_created_at TIMESTAMPTZ NOT NULL,
  desired_source_sequence BIGINT NOT NULL,
  desired_source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'awaiting_token', 'pending', 'processing', 'applied', 'failed'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token UUID,
  processing_started_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_environment, user_id, solidgate_subscription_id),
  CHECK (NULLIF(BTRIM(solidgate_subscription_id), '') IS NOT NULL),
  CHECK ((status = 'processing') = (claim_token IS NOT NULL)),
  CHECK ((status = 'processing') = (processing_started_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS solidgate_subscription_token_sync_delivery
  ON public.solidgate_subscription_token_sync_jobs (
    payment_environment, next_attempt_at, updated_at
  )
  WHERE status IN ('pending', 'processing', 'failed');

ALTER TABLE public.solidgate_subscription_token_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_subscription_token_sync_jobs
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.solidgate_subscription_token_sync_jobs IS
  'Claim-fenced newest-generation outbox that eventually points each billable subscription at the current proven account vault token.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. OPERATOR VIEW
-- ═════════════════════════════════════════════════════════════════════════════

-- Buyers charged for more than one introductory subscription. Every
-- duplicate_subscription_ids entry was granted access and needs a manual
-- refund/cancel. Empty is the healthy state.
CREATE OR REPLACE VIEW public.solidgate_intro_claims_needing_refund AS
SELECT
  payment_environment,
  email_hash,
  session_id,
  tier,
  solidgate_subscription_id AS granted_subscription_id,
  superseded_subscription_ids AS duplicate_subscription_ids,
  cardinality(superseded_subscription_ids) AS duplicate_count,
  consumed_at,
  updated_at
FROM public.solidgate_intro_claims
WHERE cardinality(superseded_subscription_ids) > 0
ORDER BY updated_at DESC;

REVOKE ALL ON public.solidgate_intro_claims_needing_refund
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.solidgate_intro_claims_needing_refund TO service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. TRIGGER FUNCTIONS
-- Every money invariant that cannot be expressed as a CHECK lives here.
-- The triggers that attach them are in section 8.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION bump_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.guard_solidgate_checkout_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT;
  v_locale TEXT;
  v_product_id TEXT;
  v_payment_action TEXT;
  v_reconcile_order TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.psp = 'solidgate' THEN
    IF NEW.psp IS DISTINCT FROM OLD.psp THEN
      RAISE EXCEPTION 'Solidgate order PSP identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.solidgate_customer_email
          IS NOT DISTINCT FROM OLD.solidgate_customer_email
       AND NEW.solidgate_checkout_locale
          IS NOT DISTINCT FROM OLD.solidgate_checkout_locale
       AND NEW.solidgate_product_id
          IS NOT DISTINCT FROM OLD.solidgate_product_id
       AND NEW.solidgate_payment_action
          IS NOT DISTINCT FROM OLD.solidgate_payment_action
       AND NEW.solidgate_checkout_identity_bound_at
          IS NOT DISTINCT FROM OLD.solidgate_checkout_identity_bound_at
       AND NEW.solidgate_checkout_identity_legacy
          IS NOT DISTINCT FROM OLD.solidgate_checkout_identity_legacy THEN
      RETURN NEW;
    END IF;

    -- Legacy reconciliation is deliberately possible only inside the
    -- postgres-only function below. A normal service-role UPDATE cannot turn
    -- today's mutable session/auth values into an alleged historical snapshot.
    v_reconcile_order := NULLIF(
      pg_catalog.current_setting('app.solidgate_identity_reconcile_order', TRUE),
      ''
    );
    IF NOT OLD.solidgate_checkout_identity_legacy
       OR OLD.solidgate_customer_email IS NOT NULL
       OR OLD.solidgate_checkout_locale IS NOT NULL
       OR OLD.solidgate_product_id IS NOT NULL
       OR OLD.solidgate_payment_action IS NOT NULL
       OR OLD.solidgate_checkout_identity_bound_at IS NOT NULL
       OR v_reconcile_order IS DISTINCT FROM OLD.id::TEXT THEN
      RAISE EXCEPTION 'Solidgate checkout identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    v_email := LOWER(BTRIM(COALESCE(NEW.solidgate_customer_email, '')));
    v_locale := BTRIM(COALESCE(NEW.solidgate_checkout_locale, ''));
    v_product_id := NULLIF(BTRIM(COALESCE(NEW.solidgate_product_id, '')), '');
    v_payment_action := BTRIM(COALESCE(NEW.solidgate_payment_action, ''));
    IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       OR CHAR_LENGTH(v_email) > 320
       OR v_locale NOT IN (
         'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
         'he', 'pl', 'hr', 'da', 'ja'
       )
       OR v_payment_action NOT IN ('auth_settle', 'auth_0_amount') THEN
      RAISE EXCEPTION 'invalid Solidgate checkout identity reconciliation'
        USING ERRCODE = '22023';
    END IF;
    NEW.solidgate_customer_email := v_email;
    NEW.solidgate_checkout_locale := v_locale;
    NEW.solidgate_product_id := v_product_id;
    NEW.solidgate_payment_action := v_payment_action;
    NEW.solidgate_checkout_identity_bound_at := NOW();
    NEW.solidgate_checkout_identity_legacy := FALSE;
    RETURN NEW;
  END IF;

  IF NEW.psp IS DISTINCT FROM 'solidgate' THEN
    RETURN NEW;
  END IF;

  -- The identity-aware opener wrappers set transaction-local values before
  -- invoking the existing atomic openers. OTO v2 writes the same two columns
  -- explicitly. In either case the INSERT itself owns the immutable snapshot.
  v_email := LOWER(BTRIM(COALESCE(
    NEW.solidgate_customer_email,
    NULLIF(pg_catalog.current_setting('app.solidgate_customer_email', TRUE), ''),
    ''
  )));
  v_locale := BTRIM(COALESCE(
    NEW.solidgate_checkout_locale,
    NULLIF(pg_catalog.current_setting('app.solidgate_checkout_locale', TRUE), ''),
    ''
  ));
  v_product_id := NULLIF(BTRIM(COALESCE(
    NEW.solidgate_product_id,
    NULLIF(pg_catalog.current_setting('app.solidgate_product_id', TRUE), ''),
    ''
  )), '');
  v_payment_action := BTRIM(COALESCE(
    NEW.solidgate_payment_action,
    NULLIF(pg_catalog.current_setting('app.solidgate_payment_action', TRUE), ''),
    ''
  ));
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR CHAR_LENGTH(v_email) > 320
     OR v_locale NOT IN (
       'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
       'he', 'pl', 'hr', 'da', 'ja'
     ) THEN
    RAISE EXCEPTION 'Solidgate order requires a valid immutable checkout identity'
      USING ERRCODE = '22023';
  END IF;
  IF v_payment_action NOT IN ('auth_settle', 'auth_0_amount') THEN
    RAISE EXCEPTION 'invalid Solidgate payment action snapshot'
      USING ERRCODE = '22023';
  END IF;
  IF v_product_id IS NOT NULL AND (
       CHAR_LENGTH(v_product_id) > 255
       OR v_product_id !~ '^[[:alnum:]_-]+$'
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate provider product identity'
      USING ERRCODE = '22023';
  END IF;
  IF (
       NEW.product_slug = 'BRAND_000000_SUB'
       OR NULLIF(BTRIM(NEW.tracking_metadata ->> 'price_id'), '') IS NOT NULL
     )
     AND v_product_id IS NULL THEN
    RAISE EXCEPTION 'Solidgate subscription order requires an immutable provider product id'
      USING ERRCODE = '22023';
  END IF;

  NEW.solidgate_customer_email := v_email;
  NEW.solidgate_checkout_locale := v_locale;
  NEW.solidgate_product_id := v_product_id;
  NEW.solidgate_payment_action := v_payment_action;
  NEW.solidgate_checkout_identity_bound_at := NOW();
  NEW.solidgate_checkout_identity_legacy := FALSE;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_main_payable_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_expected_gross INTEGER;
  v_reconcile_order TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.psp = 'solidgate'
     AND OLD.product_name = 'BRAND_000000_SUB'
     AND OLD.product_slug = 'BRAND_000000_SUB'
     AND OLD.session_id IS NOT NULL THEN
    IF NEW.psp IS DISTINCT FROM OLD.psp
       OR NEW.payment_environment IS DISTINCT FROM OLD.payment_environment
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.solidgate_order_id IS DISTINCT FROM OLD.solidgate_order_id
       OR NEW.product_name IS DISTINCT FROM OLD.product_name
       OR NEW.product_slug IS DISTINCT FROM OLD.product_slug
       OR LOWER(NEW.currency) IS DISTINCT FROM LOWER(OLD.currency)
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.tracking_metadata IS DISTINCT FROM OLD.tracking_metadata THEN
      RAISE EXCEPTION 'Solidgate main order identity binding is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.solidgate_original_amount_cents
         IS DISTINCT FROM OLD.solidgate_original_amount_cents THEN
      v_reconcile_order := NULLIF(
        pg_catalog.current_setting('app.solidgate_identity_reconcile_order', TRUE),
        ''
      );
      IF OLD.solidgate_original_amount_cents IS NOT NULL
         OR NEW.solidgate_original_amount_cents IS NULL
         OR NEW.solidgate_original_amount_cents < 0
         OR NOT OLD.solidgate_checkout_identity_legacy
         OR v_reconcile_order IS DISTINCT FROM OLD.id::TEXT THEN
        RAISE EXCEPTION 'Solidgate main original amount is immutable'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.psp IS DISTINCT FROM 'solidgate'
     OR NEW.product_name IS DISTINCT FROM 'BRAND_000000_SUB'
     OR NEW.product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR NEW.session_id IS NULL
     OR NEW.payment_environment NOT IN ('production', 'sandbox') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_expected_gross := public.solidgate_main_checkout_amount(
      NEW.tracking_metadata ->> 'product_slug',
      NEW.currency
    );
    IF v_expected_gross IS NULL
       OR NEW.amount_cents IS DISTINCT FROM v_expected_gross
       OR (
         NEW.solidgate_original_amount_cents IS NOT NULL
         AND NEW.solidgate_original_amount_cents IS DISTINCT FROM v_expected_gross
       ) THEN
      RAISE EXCEPTION 'invalid Solidgate main original amount'
        USING ERRCODE = '23514';
    END IF;
    NEW.solidgate_original_amount_cents := v_expected_gross;
  ELSIF NEW.solidgate_original_amount_cents IS NULL THEN
    RAISE EXCEPTION 'Solidgate main original amount is required'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'pending') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      NEW.payment_environment || ':' || NEW.session_id::TEXT || ':' || NEW.product_slug,
      0
    )
  );
  IF EXISTS (
    SELECT 1
    FROM public.orders AS existing
    WHERE existing.payment_environment = NEW.payment_environment
      AND existing.session_id = NEW.session_id
      AND existing.psp = 'solidgate'
      AND existing.product_slug = NEW.product_slug
      AND (
        existing.status IS DISTINCT FROM 'failed'
        OR existing.solidgate_payment_status IS NULL
        OR existing.solidgate_payment_status NOT IN ('auth_failed', 'declined', 'void_ok')
      )
      AND existing.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'a Solidgate main checkout is already payable or settled'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_oto_payable_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_internal_slug TEXT;
  v_product_step INTEGER;
  v_slug_step INTEGER;
  v_persisted_step INTEGER;
  v_old_step INTEGER;
  v_reconcile_order TEXT;
  v_oto_environment TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.psp = 'solidgate' THEN
    v_old_step := public.solidgate_oto_step_from_product_slug(OLD.product_slug);
    IF v_old_step IS NOT NULL THEN
      v_reconcile_order := NULLIF(
        pg_catalog.current_setting('app.solidgate_identity_reconcile_order', TRUE),
        ''
      );

      IF NEW.payment_environment IS DISTINCT FROM OLD.payment_environment
         OR NEW.session_id IS DISTINCT FROM OLD.session_id
         OR NEW.psp IS DISTINCT FROM OLD.psp
         OR NEW.product_name IS DISTINCT FROM OLD.product_name
         OR NEW.product_slug IS DISTINCT FROM OLD.product_slug
         OR NEW.solidgate_order_id IS DISTINCT FROM OLD.solidgate_order_id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.tracking_metadata IS DISTINCT FROM OLD.tracking_metadata THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Solidgate OTO order binding is immutable';
      END IF;

      IF NEW.solidgate_original_amount_cents
           IS DISTINCT FROM OLD.solidgate_original_amount_cents
         AND NOT (
           OLD.solidgate_checkout_identity_legacy
           AND OLD.solidgate_original_amount_cents IS NULL
           AND NEW.solidgate_original_amount_cents IS NOT NULL
           AND NEW.solidgate_original_amount_cents >= 0
           AND v_reconcile_order = OLD.id::TEXT
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Solidgate OTO original gross is immutable';
      END IF;

      IF (
        NEW.solidgate_customer_email IS DISTINCT FROM OLD.solidgate_customer_email
        OR NEW.solidgate_checkout_locale IS DISTINCT FROM OLD.solidgate_checkout_locale
        OR NEW.solidgate_product_id IS DISTINCT FROM OLD.solidgate_product_id
        OR NEW.solidgate_payment_action IS DISTINCT FROM OLD.solidgate_payment_action
        OR NEW.solidgate_checkout_identity_bound_at
             IS DISTINCT FROM OLD.solidgate_checkout_identity_bound_at
        OR NEW.solidgate_checkout_identity_legacy
             IS DISTINCT FROM OLD.solidgate_checkout_identity_legacy
      ) AND NOT (
        OLD.solidgate_checkout_identity_legacy
        AND v_reconcile_order = OLD.id::TEXT
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Solidgate OTO customer identity is immutable';
      END IF;
    END IF;
  END IF;

  IF NEW.psp IS DISTINCT FROM 'solidgate'
     OR NEW.session_id IS NULL
     OR NEW.payment_environment NOT IN ('production', 'sandbox')
     OR NEW.product_slug IS NULL
     OR NEW.product_slug = 'BRAND_000000_SUB'
     OR NEW.solidgate_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_internal_slug := pg_catalog.split_part(NEW.solidgate_order_id, ':', 2);
  v_product_step := public.solidgate_oto_step_from_product_slug(NEW.product_slug);
  v_slug_step := public.solidgate_oto_step_from_internal_slug(v_internal_slug);
  IF pg_catalog.split_part(NEW.solidgate_order_id, ':', 1)
       IS DISTINCT FROM NEW.session_id::TEXT
     OR pg_catalog.split_part(NEW.solidgate_order_id, ':', 3)
       !~ '^[1-9][0-9]{0,8}$'
     OR pg_catalog.split_part(NEW.solidgate_order_id, ':', 4) <> ''
     OR v_product_step IS NULL
     OR v_slug_step IS NULL
     OR v_product_step IS DISTINCT FROM v_slug_step
     OR NEW.product_name IS DISTINCT FROM NEW.product_slug
     OR NEW.solidgate_original_amount_cents IS NULL
     OR NEW.solidgate_original_amount_cents < 0
     OR LOWER(NEW.currency) !~ '^[a-z]{3}$'
     OR NEW.currency IS DISTINCT FROM LOWER(NEW.currency)
     OR NEW.tracking_metadata IS NULL
     OR jsonb_typeof(NEW.tracking_metadata) <> 'object'
     OR NEW.tracking_metadata ->> 'session_id' IS DISTINCT FROM NEW.session_id::TEXT
     OR NEW.tracking_metadata ->> 'product_slug' IS DISTINCT FROM v_internal_slug
     OR NEW.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
     OR NEW.tracking_metadata ->> 'funnel_variant'
          IS DISTINCT FROM ('oto' || v_product_step::TEXT)
     OR (
       v_product_step = 2
       AND (
         NULLIF(BTRIM(NEW.tracking_metadata ->> 'price_id'), '') IS NULL
         OR NEW.tracking_metadata ? 'locale'
         OR NULLIF(BTRIM(NEW.solidgate_product_id), '') IS NULL
       )
     )
     OR (
       v_product_step <> 2
       AND (
         NULLIF(BTRIM(NEW.tracking_metadata ->> 'locale'), '') IS NULL
         OR NEW.tracking_metadata ->> 'locale'
              IS DISTINCT FROM NEW.solidgate_checkout_locale
         OR NEW.tracking_metadata ? 'price_id'
         OR NEW.solidgate_product_id IS NOT NULL
       )
     )
     OR NEW.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
     OR NEW.solidgate_checkout_identity_legacy
     OR NULLIF(BTRIM(NEW.solidgate_customer_email), '') IS NULL
     OR NULLIF(BTRIM(NEW.solidgate_checkout_locale), '') IS NULL
     OR NEW.solidgate_checkout_identity_bound_at IS NULL
     OR (TG_OP = 'INSERT'
       AND NEW.amount_cents IS DISTINCT FROM NEW.solidgate_original_amount_cents) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid canonical Solidgate OTO step binding';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Inserts have not locked an order tuple yet, so they can safely take the
    -- same advisory→session order used by the opener. UPDATE triggers run after
    -- PostgreSQL has acquired their tuple lock; the unique step index protects
    -- them without introducing the reverse tuple→advisory deadlock order.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        NEW.payment_environment || ':' || NEW.session_id::TEXT || ':oto-step:' ||
          v_product_step::TEXT,
        0
      )
    );

    SELECT
      public.solidgate_persisted_oto_step(session_row.last_oto_step),
      session_row.solidgate_oto_environment
    INTO v_persisted_step, v_oto_environment
    FROM public.sessions AS session_row
    WHERE session_row.id = NEW.session_id
    FOR UPDATE;

    IF NOT FOUND OR v_persisted_step IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'invalid persisted OTO step';
    END IF;
    IF v_oto_environment IS NULL THEN
      UPDATE public.sessions AS session_row
      SET solidgate_oto_environment = NEW.payment_environment,
          updated_at = NOW()
      WHERE session_row.id = NEW.session_id;
    ELSIF v_oto_environment IS DISTINCT FROM NEW.payment_environment THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'oto_progress_environment_mismatch';
    END IF;
    IF v_persisted_step IS DISTINCT FROM v_product_step THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'oto_progress_conflict';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.orders AS existing
    WHERE existing.payment_environment = NEW.payment_environment
      AND existing.session_id = NEW.session_id
      AND existing.psp = 'solidgate'
      AND existing.id IS DISTINCT FROM NEW.id
      AND public.solidgate_oto_step_from_product_slug(existing.product_slug)
            = v_product_step
      AND (
        existing.status IS DISTINCT FROM 'failed'
        OR existing.amount_cents IS DISTINCT FROM 0
        OR existing.solidgate_payment_status IS NULL
        OR existing.solidgate_payment_status
             NOT IN ('auth_failed', 'declined', 'void_ok', 'request_rejected')
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'a Solidgate OTO step is already payable, settled, or uncertain';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_pwa_payable_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_account_ref TEXT;
  v_offer_slug TEXT;
  v_expected_product TEXT;
  v_expected_prefix TEXT;
  v_attempt_text TEXT;
  v_gross INTEGER;
  v_reconcile_order TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.psp = 'solidgate'
     AND OLD.session_id IS NULL
     AND OLD.user_id IS NOT NULL
     AND OLD.tracking_metadata ->> 'funnel_code' = 'PWA' THEN
    IF NEW.psp IS DISTINCT FROM OLD.psp
       OR NEW.payment_environment IS DISTINCT FROM OLD.payment_environment
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.solidgate_order_id IS DISTINCT FROM OLD.solidgate_order_id
       OR NEW.product_slug IS DISTINCT FROM OLD.product_slug
       OR NEW.product_name IS DISTINCT FROM OLD.product_name
       OR LOWER(NEW.currency) IS DISTINCT FROM LOWER(OLD.currency)
       OR NEW.tracking_metadata IS DISTINCT FROM OLD.tracking_metadata THEN
      RAISE EXCEPTION 'Solidgate PWA order identity binding is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.solidgate_original_amount_cents
         IS DISTINCT FROM OLD.solidgate_original_amount_cents THEN
      v_reconcile_order := NULLIF(
        pg_catalog.current_setting('app.solidgate_identity_reconcile_order', TRUE),
        ''
      );
      IF OLD.solidgate_original_amount_cents IS NOT NULL
         OR NEW.solidgate_original_amount_cents IS NULL
         OR NEW.solidgate_original_amount_cents <= 0
         OR NOT OLD.solidgate_checkout_identity_legacy
         OR v_reconcile_order IS DISTINCT FROM OLD.id::TEXT THEN
        RAISE EXCEPTION 'Solidgate PWA original amount is immutable'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.psp IS DISTINCT FROM 'solidgate'
     OR NEW.session_id IS NOT NULL
     OR NEW.user_id IS NULL
     OR NEW.solidgate_order_id IS NULL
     OR NEW.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA' THEN
    RETURN NEW;
  END IF;

  v_account_ref := 'u-' || NEW.user_id::TEXT;
  v_offer_slug := pg_catalog.split_part(NEW.solidgate_order_id, ':', 2);
  v_expected_prefix := v_account_ref || ':' || v_offer_slug || ':';
  v_attempt_text := pg_catalog.split_part(NEW.solidgate_order_id, ':', 3);
  v_expected_product := CASE
    WHEN TG_OP = 'INSERT' THEN public.solidgate_pwa_product_code(v_offer_slug)
    ELSE OLD.product_slug
  END;

  IF NEW.payment_environment NOT IN ('production', 'sandbox')
     OR v_expected_product IS NULL
     OR NEW.product_slug IS DISTINCT FROM v_expected_product
     OR NEW.product_name IS DISTINCT FROM v_expected_product
     OR LEFT(NEW.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR v_attempt_text !~ '^[1-9][0-9]{0,8}$'
     OR pg_catalog.split_part(NEW.solidgate_order_id, ':', 4) <> ''
     OR NEW.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR NEW.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR NEW.tracking_metadata ->> 'product_slug' IS DISTINCT FROM v_offer_slug THEN
    RAISE EXCEPTION 'invalid canonical Solidgate PWA order binding'
      USING ERRCODE = '23514';
  END IF;

  IF v_offer_slug = 'oto2_addon_weekly' THEN
    IF NULLIF(BTRIM(NEW.tracking_metadata ->> 'price_id'), '') IS NULL
       OR NULLIF(BTRIM(NEW.tracking_metadata ->> 'locale'), '') IS NOT NULL THEN
      RAISE EXCEPTION 'invalid Solidgate PWA add-on price binding'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NULLIF(BTRIM(NEW.tracking_metadata ->> 'locale'), '') IS NULL
        OR NULLIF(BTRIM(NEW.tracking_metadata ->> 'price_id'), '') IS NOT NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA library locale binding'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.amount_cents IS NULL OR NEW.amount_cents <= 0
       OR (
         NEW.solidgate_original_amount_cents IS NOT NULL
         AND NEW.solidgate_original_amount_cents IS DISTINCT FROM NEW.amount_cents
       ) THEN
      RAISE EXCEPTION 'invalid Solidgate PWA original amount'
        USING ERRCODE = '23514';
    END IF;
    NEW.solidgate_original_amount_cents := NEW.amount_cents;
    NEW.solidgate_payment_status := COALESCE(NEW.solidgate_payment_status, 'creating');
    NEW.solidgate_submission_token := COALESCE(NEW.solidgate_submission_token, gen_random_uuid());
    NEW.solidgate_submission_started_at := COALESCE(NEW.solidgate_submission_started_at, NOW());
  END IF;
  v_gross := COALESCE(NEW.solidgate_original_amount_cents, NEW.amount_cents);
  IF v_gross IS NULL OR v_gross <= 0 THEN
    RAISE EXCEPTION 'invalid Solidgate PWA gross amount'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'solidgate:pwa:' || NEW.payment_environment || ':' ||
        NEW.user_id::TEXT || ':' || NEW.product_slug,
        0
      )
    );
    IF EXISTS (
      SELECT 1
      FROM public.orders AS existing
      WHERE existing.payment_environment = NEW.payment_environment
        AND existing.user_id = NEW.user_id
        AND existing.session_id IS NULL
        AND existing.psp = 'solidgate'
        AND existing.product_slug = NEW.product_slug
        AND NOT (
          (
            existing.status = 'failed'
            AND existing.amount_cents = 0
            AND COALESCE(existing.solidgate_original_amount_cents, existing.amount_cents) > 0
            AND COALESCE(
              existing.solidgate_payment_status IN (
                'auth_failed', 'declined', 'void_ok', 'request_rejected'
              ),
              FALSE
            )
          )
          OR existing.status IN ('canceled', 'expired', 'refunded')
        )
    ) THEN
      RAISE EXCEPTION 'a Solidgate PWA order is already payable or uncertain'
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_session_vault_card_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_expected_fence TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      NEW.customer_account_id IS DISTINCT FROM OLD.customer_account_id
      OR NEW.card_token IS DISTINCT FROM OLD.card_token
      OR NEW.card_brand IS DISTINCT FROM OLD.card_brand
      OR NEW.card_last4 IS DISTINCT FROM OLD.card_last4
      OR NEW.card_source_order_id IS DISTINCT FROM OLD.card_source_order_id
      OR NEW.card_source_created_at IS DISTINCT FROM OLD.card_source_created_at
      OR NEW.card_source_sequence IS DISTINCT FROM OLD.card_source_sequence
      OR NEW.card_source_legacy IS DISTINCT FROM OLD.card_source_legacy
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  v_expected_fence := NULLIF(
    pg_catalog.current_setting('app.solidgate_session_vault_source_write', TRUE),
    ''
  );
  IF TG_OP = 'UPDATE'
     AND OLD.card_source_legacy
     AND NEW.customer_account_id IS NOT DISTINCT FROM OLD.customer_account_id
     AND NEW.card_token IS NULL
     AND NEW.card_brand IS NULL
     AND NEW.card_last4 IS NULL
     AND NEW.card_source_order_id IS NULL
     AND NEW.card_source_created_at IS NULL
     AND NEW.card_source_sequence IS NULL
     AND NOT NEW.card_source_legacy
     AND v_expected_fence = 'operator-clear:' || NEW.session_id::TEXT THEN
    RETURN NEW;
  END IF;
  IF v_expected_fence IS DISTINCT FROM COALESCE(NEW.card_source_order_id::TEXT, '') THEN
    RAISE EXCEPTION 'Solidgate session vault token requires an exact-order monotonic writer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_session_vault_payment_method()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_expected_fence TEXT;
  v_source_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_source_changed := (
      NEW.card_source_order_id IS DISTINCT FROM OLD.card_source_order_id
      OR NEW.card_source_created_at IS DISTINCT FROM OLD.card_source_created_at
      OR NEW.card_source_sequence IS DISTINCT FROM OLD.card_source_sequence
      OR NEW.card_source_legacy IS DISTINCT FROM OLD.card_source_legacy
    );
    IF v_source_changed THEN
      NEW.card_original_payment_method := NULL;
    END IF;
    IF NEW.card_original_payment_method
         IS NOT DISTINCT FROM OLD.card_original_payment_method THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.card_original_payment_method IS NULL THEN
    RETURN NEW;
  END IF;

  v_expected_fence := NULLIF(
    pg_catalog.current_setting(
      'app.solidgate_session_vault_source_write',
      TRUE
    ),
    ''
  );

  -- Preserve the existing operator-only legacy hard-zero recovery. The source
  -- guard independently requires this exact fence and completely empty target.
  IF TG_OP = 'UPDATE'
     AND OLD.card_source_legacy
     AND NEW.customer_account_id IS NOT DISTINCT FROM OLD.customer_account_id
     AND NEW.card_token IS NULL
     AND NEW.card_brand IS NULL
     AND NEW.card_last4 IS NULL
     AND NEW.card_original_payment_method IS NULL
     AND NEW.card_source_order_id IS NULL
     AND NEW.card_source_created_at IS NULL
     AND NEW.card_source_sequence IS NULL
     AND NOT NEW.card_source_legacy
     AND v_expected_fence = 'operator-clear:' || NEW.session_id::TEXT THEN
    RETURN NEW;
  END IF;

  IF v_expected_fence IS DISTINCT FROM COALESCE(
    NEW.card_source_order_id::TEXT,
    ''
  ) THEN
    RAISE EXCEPTION
      'Solidgate session vault payment method requires an exact-order monotonic writer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_account_vault_card_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_expected_fence TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
       NEW.card_token IS DISTINCT FROM OLD.card_token
       OR NEW.card_brand IS DISTINCT FROM OLD.card_brand
       OR NEW.card_last4 IS DISTINCT FROM OLD.card_last4
       OR NEW.card_source_kind IS DISTINCT FROM OLD.card_source_kind
       OR NEW.card_source_created_at IS DISTINCT FROM OLD.card_source_created_at
       OR NEW.card_source_sequence IS DISTINCT FROM OLD.card_source_sequence
       OR NEW.card_source_id IS DISTINCT FROM OLD.card_source_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_expected_fence := NULLIF(
      pg_catalog.current_setting('app.solidgate_vault_source_write', TRUE),
      ''
    );
    IF v_expected_fence IS DISTINCT FROM (
      NEW.card_source_kind || ':' || NEW.card_source_id
    ) THEN
      RAISE EXCEPTION 'Solidgate account vault token requires a monotonic source writer'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_solidgate_account_vault_payment_method()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_expected_fence TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.card_source_kind IS DISTINCT FROM OLD.card_source_kind
       OR NEW.card_source_created_at IS DISTINCT FROM OLD.card_source_created_at
       OR NEW.card_source_sequence IS DISTINCT FROM OLD.card_source_sequence
       OR NEW.card_source_id IS DISTINCT FROM OLD.card_source_id THEN
      NEW.card_original_payment_method := NULL;
    END IF;
    IF NEW.card_original_payment_method
         IS NOT DISTINCT FROM OLD.card_original_payment_method THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.card_original_payment_method IS NULL THEN
    RETURN NEW;
  END IF;

  v_expected_fence := NULLIF(
    pg_catalog.current_setting('app.solidgate_vault_source_write', TRUE),
    ''
  );
  IF v_expected_fence IS DISTINCT FROM (
    NEW.card_source_kind || ':' || NEW.card_source_id
  ) THEN
    RAISE EXCEPTION
      'Solidgate account vault payment method requires a monotonic source writer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_solidgate_entitlement_replay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  payment_order public.orders%ROWTYPE;
  v_old_special_free BOOLEAN := FALSE;
  v_new_special_free_provenance BOOLEAN := FALSE;
  v_payment_order_special_free BOOLEAN := FALSE;
  v_established_special_free BOOLEAN := FALSE;
BEGIN
  -- Determine special_free provenance by either the order pointer or the
  -- provider subscription.  The latter is essential when an unsafe historic
  -- writer has already detached/rebound order_id.
  --
  -- Only the ZERO-AUTH generation (payment_action auth_0_amount) counts as
  -- special_free here: since 2026-07-29 the tier settles a €1 intro and is an
  -- ordinary paid purchase, indistinguishable in risk from special_1eur.
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.orders AS candidate
      WHERE candidate.psp = 'solidgate'
        AND candidate.tracking_metadata ->> 'funnel_code' = 'BRAND'
        AND candidate.tracking_metadata ->> 'funnel_variant' = 'special_free'
        AND candidate.tracking_metadata ->> 'product_slug' = 'special_free'
        AND candidate.solidgate_payment_action = 'auth_0_amount'
        AND (
          candidate.id = OLD.order_id
          OR (
            candidate.payment_environment = OLD.payment_environment
            AND NULLIF(BTRIM(OLD.solidgate_subscription_id), '') IS NOT NULL
            AND candidate.solidgate_subscription_id
                  = OLD.solidgate_subscription_id
          )
        )
    ) INTO v_old_special_free;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.orders AS candidate
    WHERE candidate.psp = 'solidgate'
      AND candidate.tracking_metadata ->> 'funnel_code' = 'BRAND'
      AND candidate.tracking_metadata ->> 'funnel_variant' = 'special_free'
      AND candidate.tracking_metadata ->> 'product_slug' = 'special_free'
      AND candidate.solidgate_payment_action = 'auth_0_amount'
      AND (
        candidate.id = NEW.order_id
        OR (
          candidate.payment_environment = NEW.payment_environment
          AND NULLIF(BTRIM(NEW.solidgate_subscription_id), '') IS NOT NULL
          AND candidate.solidgate_subscription_id
                = NEW.solidgate_subscription_id
        )
      )
  ) INTO v_new_special_free_provenance;

  -- Revocation is a tombstone for this exact purchase. It may only be cleared
  -- by a new purchase whose entitlement upsert replaces order_id.
  IF TG_OP = 'UPDATE'
    AND (OLD.revoked_at IS NOT NULL OR OLD.status = 'canceled')
    AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id
    AND NEW.revoked_at IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'cannot reactivate a revoked entitlement with the same order';
  END IF;

  -- special_free provenance is sticky. Revoking/canceling access must retain
  -- its audit binding; otherwise a two-step cancel+detach could erase the
  -- information needed to reject a later unsafe reactivation.
  IF TG_OP = 'UPDATE'
     AND v_old_special_free
     AND NEW.order_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cannot detach a special_free entitlement from its verified order';
  END IF;

  IF NEW.revoked_at IS NULL
     AND NEW.status IN ('active', 'past_due')
     AND v_new_special_free_provenance
     AND NEW.order_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cannot grant detached special_free access';
  END IF;

  -- Live grants always inspect their order. An established special_free row is
  -- also inspected while revoked so cancel+rebind cannot erase provenance in
  -- one statement and reactivate through the unrelated order in a second.
  IF NEW.order_id IS NOT NULL
     AND (
       NEW.revoked_at IS NULL
       OR (TG_OP = 'UPDATE' AND v_old_special_free)
     ) THEN
    SELECT candidate.*
    INTO payment_order
    FROM public.orders AS candidate
    WHERE candidate.id = NEW.order_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'entitlement grant order does not exist';
    END IF;

    IF payment_order.payment_environment IS DISTINCT FROM NEW.payment_environment THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'entitlement and order payment environments do not match';
    END IF;

    IF NEW.revoked_at IS NULL
       AND payment_order.psp = 'solidgate' AND (
      payment_order.status IN ('canceled', 'refunded', 'disputed')
      -- `refunded` at provider level may be a partial refund. The lifecycle
      -- handler promotes orders.status to `refunded` only when net reaches 0.
      OR payment_order.solidgate_payment_status = 'void_ok'
      OR payment_order.solidgate_chargeback_id IS NOT NULL
      OR payment_order.solidgate_chargeback_status IS NOT NULL
      OR payment_order.solidgate_chargeback_amount_cents > 0
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'cannot grant entitlement for a terminal Solidgate order';
    END IF;

    v_payment_order_special_free :=
      payment_order.psp = 'solidgate'
      AND payment_order.tracking_metadata ->> 'funnel_code' = 'BRAND'
      AND payment_order.tracking_metadata ->> 'funnel_variant' = 'special_free'
      AND payment_order.tracking_metadata ->> 'product_slug' = 'special_free'
      AND payment_order.solidgate_payment_action = 'auth_0_amount';

    -- An established special_free entitlement cannot shed its provenance by
    -- rebinding to Stripe, a paid Solidgate order, or any unrelated order. A
    -- genuine replacement special_free purchase is allowed only when that new
    -- order independently has exact reusable-card proof.
    IF TG_OP = 'UPDATE' AND v_old_special_free THEN
      IF NOT v_payment_order_special_free
         OR NEW.user_id IS DISTINCT FROM payment_order.user_id
         OR NEW.product_slug IS DISTINCT FROM payment_order.product_slug
         OR NEW.solidgate_subscription_id
              IS DISTINCT FROM payment_order.solidgate_subscription_id
         OR (
           OLD.order_id IS DISTINCT FROM NEW.order_id
           AND NOT public.solidgate_special_free_card_ready(payment_order.id)
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'cannot rebind a special_free entitlement without a new verified special_free purchase';
      END IF;
    END IF;

    IF NEW.revoked_at IS NULL
       AND NEW.status IN ('active', 'past_due')
       AND (v_payment_order_special_free OR v_new_special_free_provenance) THEN
      IF TG_OP = 'UPDATE' THEN
        v_established_special_free :=
          OLD.revoked_at IS NULL
          AND OLD.status IN ('active', 'past_due')
          AND OLD.payment_environment IS NOT DISTINCT FROM NEW.payment_environment
          AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id
          AND OLD.user_id IS NOT DISTINCT FROM payment_order.user_id
          AND OLD.product_slug IS NOT DISTINCT FROM payment_order.product_slug
          AND OLD.solidgate_subscription_id
                IS NOT DISTINCT FROM payment_order.solidgate_subscription_id;
      END IF;

      IF NOT v_payment_order_special_free
         OR NEW.user_id IS DISTINCT FROM payment_order.user_id
         OR NEW.product_slug IS DISTINCT FROM payment_order.product_slug
         OR NEW.solidgate_subscription_id
              IS DISTINCT FROM payment_order.solidgate_subscription_id
         OR (
           NOT v_established_special_free
           AND NOT public.solidgate_special_free_card_ready(payment_order.id)
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'cannot grant special_free entitlement without exact reusable-card proof';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_solidgate_subscription_token_sync_from_entitlement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_vault public.solidgate_account_vault%ROWTYPE;
BEGIN
  IF NEW.payment_environment IN ('production', 'sandbox')
     AND NEW.user_id IS NOT NULL
     AND NEW.status IN ('active', 'past_due')
     AND NEW.revoked_at IS NULL
     AND NULLIF(BTRIM(COALESCE(NEW.solidgate_subscription_id, '')), '') IS NOT NULL THEN
    SELECT vault.*
    INTO v_vault
    FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = NEW.payment_environment
      AND vault.user_id = NEW.user_id;

    IF FOUND
       AND v_vault.card_token IS NULL
       AND v_vault.card_source_kind IN ('main_order', 'pwa_order') THEN
      PERFORM public.fence_solidgate_subscription_token_sync_for_tokenless_source(
        v_vault.payment_environment,
        v_vault.user_id,
        v_vault.card_source_kind,
        v_vault.card_source_created_at,
        v_vault.card_source_sequence,
        v_vault.card_source_id
      );
    ELSE
      PERFORM public.enqueue_solidgate_subscription_token_sync(
        NEW.payment_environment,
        NEW.user_id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;



-- ════════════════════════════════════════════════════════════════════════════
-- 7. RPCs
-- Signatures are load-bearing: PostgREST resolves .rpc() by argument name,
-- so renaming a parameter is a breaking API change.
-- ════════════════════════════════════════════════════════════════════════════


-- ── webhook lifecycle: idempotency, entity ordering, outbox claims ──────────

CREATE OR REPLACE FUNCTION public.claim_solidgate_webhook_event(
  p_event_id TEXT,
  p_type TEXT,
  p_event_created_at TIMESTAMPTZ,
  p_environment TEXT,
  p_payload JSONB,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_claimed BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.solidgate_webhook_events (
    event_id,
    type,
    event_created_at,
    environment,
    payload,
    status,
    attempts,
    processing_started_at,
    completed_at,
    failed_at,
    last_error,
    updated_at,
    claim_token,
    claim_generation
  ) VALUES (
    p_event_id,
    p_type,
    p_event_created_at,
    p_environment,
    p_payload,
    'processing',
    1,
    NOW(),
    NULL,
    NULL,
    NULL,
    NOW(),
    NULL,
    1
  )
  ON CONFLICT (environment, event_id) DO UPDATE
  SET type = EXCLUDED.type,
      event_created_at = EXCLUDED.event_created_at,
      payload = EXCLUDED.payload,
      status = 'processing',
      attempts = public.solidgate_webhook_events.attempts + 1,
      processing_started_at = NOW(),
      completed_at = NULL,
      failed_at = NULL,
      last_error = NULL,
      updated_at = NOW(),
      claim_token = NULL,
      claim_generation = public.solidgate_webhook_events.claim_generation + 1
  WHERE public.solidgate_webhook_events.status = 'failed'
     OR (
       public.solidgate_webhook_events.status = 'processing'
       AND (
         public.solidgate_webhook_events.processing_started_at IS NULL
         OR public.solidgate_webhook_events.processing_started_at
           < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30))
       )
     )
  RETURNING TRUE INTO v_claimed;

  RETURN COALESCE(v_claimed, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_solidgate_webhook_event_v2(
  p_event_id TEXT,
  p_type TEXT,
  p_event_created_at TIMESTAMPTZ,
  p_environment TEXT,
  p_payload JSONB,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  claim_state TEXT,
  claim_token UUID,
  claim_generation BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_claimed_token UUID;
  v_generation BIGINT;
  v_status TEXT;
BEGIN
  IF NULLIF(BTRIM(p_event_id), '') IS NULL
     OR NULLIF(BTRIM(p_type), '') IS NULL
     OR p_event_created_at IS NULL
     OR p_environment NOT IN ('production', 'sandbox')
     OR p_payload IS NULL
     OR p_lease_seconds IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate webhook claim'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.solidgate_webhook_events (
    event_id,
    type,
    event_created_at,
    environment,
    payload,
    status,
    attempts,
    processing_started_at,
    completed_at,
    failed_at,
    last_error,
    updated_at,
    claim_token,
    claim_generation
  ) VALUES (
    p_event_id,
    p_type,
    p_event_created_at,
    p_environment,
    p_payload,
    'processing',
    1,
    NOW(),
    NULL,
    NULL,
    NULL,
    NOW(),
    v_token,
    1
  )
  ON CONFLICT (environment, event_id) DO UPDATE
  SET type = EXCLUDED.type,
      event_created_at = EXCLUDED.event_created_at,
      payload = EXCLUDED.payload,
      status = 'processing',
      attempts = public.solidgate_webhook_events.attempts + 1,
      processing_started_at = NOW(),
      completed_at = NULL,
      failed_at = NULL,
      last_error = NULL,
      updated_at = NOW(),
      claim_token = v_token,
      claim_generation = public.solidgate_webhook_events.claim_generation + 1
  WHERE public.solidgate_webhook_events.status = 'failed'
     OR (
       public.solidgate_webhook_events.status = 'processing'
       AND (
         public.solidgate_webhook_events.processing_started_at IS NULL
         OR public.solidgate_webhook_events.processing_started_at
           < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30))
       )
     )
  RETURNING
    public.solidgate_webhook_events.claim_token,
    public.solidgate_webhook_events.claim_generation
  INTO v_claimed_token, v_generation;

  IF v_claimed_token IS NOT NULL THEN
    RETURN QUERY SELECT 'claimed'::TEXT, v_claimed_token, v_generation;
    RETURN;
  END IF;

  -- ON CONFLICT serialises on the inbox primary key. This read therefore sees
  -- the durable state of the worker that won the row lock.
  SELECT event.status, event.claim_generation
  INTO v_status, v_generation
  FROM public.solidgate_webhook_events AS event
  WHERE event.environment = p_environment
    AND event.event_id = p_event_id;

  IF v_status = 'completed' THEN
    RETURN QUERY SELECT 'completed'::TEXT, NULL::UUID, v_generation;
    RETURN;
  END IF;
  IF v_status = 'processing' THEN
    RETURN QUERY SELECT 'busy'::TEXT, NULL::UUID, v_generation;
    RETURN;
  END IF;

  RAISE EXCEPTION 'unexpected Solidgate webhook inbox state % for %/%',
    COALESCE(v_status, '<missing>'), p_environment, p_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_solidgate_webhook_event_v2(
  p_environment TEXT,
  p_event_id TEXT,
  p_claim_token UUID,
  p_claim_generation BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_environment NOT IN ('production', 'sandbox')
     OR NULLIF(BTRIM(p_event_id), '') IS NULL
     OR p_claim_token IS NULL
     OR p_claim_generation IS NULL
     OR p_claim_generation < 1 THEN
    RAISE EXCEPTION 'invalid Solidgate webhook completion claim'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.solidgate_webhook_events AS event
  SET status = 'completed',
      completed_at = NOW(),
      processing_started_at = NULL,
      failed_at = NULL,
      last_error = NULL,
      updated_at = NOW(),
      claim_token = NULL
  WHERE event.environment = p_environment
    AND event.event_id = p_event_id
    AND event.status = 'processing'
    AND event.claim_token = p_claim_token
    AND event.claim_generation = p_claim_generation;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_solidgate_webhook_event_v2(
  p_environment TEXT,
  p_event_id TEXT,
  p_claim_token UUID,
  p_claim_generation BIGINT,
  p_last_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF p_environment NOT IN ('production', 'sandbox')
     OR NULLIF(BTRIM(p_event_id), '') IS NULL
     OR p_claim_token IS NULL
     OR p_claim_generation IS NULL
     OR p_claim_generation < 1
     OR NULLIF(BTRIM(p_last_error), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate webhook failure claim'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.solidgate_webhook_events AS event
  SET status = 'failed',
      failed_at = NOW(),
      processing_started_at = NULL,
      last_error = LEFT(p_last_error, 4000),
      updated_at = NOW(),
      claim_token = NULL
  WHERE event.environment = p_environment
    AND event.event_id = p_event_id
    AND event.status = 'processing'
    AND event.claim_token = p_claim_token
    AND event.claim_generation = p_claim_generation;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_solidgate_entity_event(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_event_created_at TIMESTAMPTZ,
  p_event_id TEXT,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.solidgate_entity_watermarks%ROWTYPE;
BEGIN
  IF NULLIF(BTRIM(p_entity_type), '') IS NULL
     OR NULLIF(BTRIM(p_entity_id), '') IS NULL
     OR p_event_created_at IS NULL
     OR NULLIF(BTRIM(p_event_id), '') IS NULL
     OR p_lease_seconds IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate entity event claim'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.solidgate_entity_watermarks (entity_type, entity_id)
  VALUES (p_entity_type, p_entity_id)
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_row
  FROM public.solidgate_entity_watermarks
  WHERE entity_type = p_entity_type AND entity_id = p_entity_id
  FOR UPDATE;

  -- Only the provider timestamp is chronological. Distinct callbacks with an
  -- equal timestamp must both reach the monotonic, idempotent domain handlers.
  IF v_row.last_event_created_at IS NOT NULL
     AND p_event_created_at < v_row.last_event_created_at THEN
    RETURN 'stale';
  END IF;

  IF v_row.processing_event_id IS NOT NULL
     AND v_row.processing_event_id <> p_event_id
     AND v_row.processing_started_at >=
       NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30)) THEN
    RETURN 'busy';
  END IF;

  UPDATE public.solidgate_entity_watermarks
  SET processing_event_created_at = p_event_created_at,
      processing_event_id = p_event_id,
      processing_started_at = NOW(),
      updated_at = NOW()
  WHERE entity_type = p_entity_type AND entity_id = p_entity_id;

  RETURN 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION complete_solidgate_entity_event(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_event_created_at TIMESTAMPTZ,
  p_event_id TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.solidgate_entity_watermarks
  SET last_event_created_at = p_event_created_at,
      last_event_id = p_event_id,
      processing_event_created_at = NULL,
      processing_event_id = NULL,
      processing_started_at = NULL,
      updated_at = NOW()
  WHERE entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND processing_event_id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION release_solidgate_entity_event(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_event_id TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.solidgate_entity_watermarks
  SET processing_event_created_at = NULL,
      processing_event_id = NULL,
      processing_started_at = NULL,
      updated_at = NOW()
  WHERE entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND processing_event_id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION claim_solidgate_analytics_outbox(
  p_environment TEXT,
  p_limit INTEGER DEFAULT 25,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS SETOF public.solidgate_analytics_outbox
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH candidates AS (
    SELECT id
    FROM public.solidgate_analytics_outbox
    WHERE environment = p_environment
      AND (
      (status IN ('pending', 'failed') AND next_attempt_at <= NOW())
      OR (
        status = 'processing'
        AND processing_started_at < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30))
      )
    )
    ORDER BY created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.solidgate_analytics_outbox AS outbox
  SET status = 'processing',
      attempts = outbox.attempts + 1,
      processing_started_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  FROM candidates
  WHERE outbox.id = candidates.id
  RETURNING outbox.*;
$$;

CREATE OR REPLACE FUNCTION public.claim_solidgate_fulfillment_outbox(
  p_environment TEXT,
  p_limit INTEGER DEFAULT 10,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.solidgate_fulfillment_outbox
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH candidates AS (
    SELECT id
    FROM public.solidgate_fulfillment_outbox
    WHERE environment = p_environment
      AND (
        (status IN ('pending', 'failed') AND next_attempt_at <= NOW())
        OR (
          status = 'processing'
          AND processing_started_at
            < NOW() - make_interval(secs => GREATEST(p_lease_seconds, 30))
        )
      )
    ORDER BY created_at, id
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.solidgate_fulfillment_outbox AS outbox
  SET status = 'processing',
      attempts = outbox.attempts + 1,
      claim_token = gen_random_uuid(),
      processing_started_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  FROM candidates
  WHERE outbox.id = candidates.id
  RETURNING outbox.*;
$$;


-- ── checkout + order lifecycle ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.solidgate_checkout_core_is_canonical(
  p_order public.orders
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_metadata JSONB := p_order.tracking_metadata;
  v_internal_slug TEXT;
  v_expected_code TEXT;
  v_expected_prefix TEXT;
  v_expected_variant TEXT;
  v_is_catalog_subscription BOOLEAN;
BEGIN
  IF p_order.psp IS DISTINCT FROM 'solidgate'
     OR p_order.payment_environment NOT IN ('production', 'sandbox')
     OR p_order.solidgate_order_id IS NULL
     OR p_order.product_slug IS NULL
     OR p_order.product_name IS DISTINCT FROM p_order.product_slug
     OR v_metadata IS NULL
     OR pg_catalog.jsonb_typeof(v_metadata) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_each(v_metadata) AS entry
       WHERE pg_catalog.jsonb_typeof(entry.value) IS DISTINCT FROM 'string'
     ) THEN
    RETURN FALSE;
  END IF;

  v_internal_slug := NULLIF(BTRIM(v_metadata ->> 'product_slug'), '');
  v_expected_code := CASE v_internal_slug
    WHEN 'trial1' THEN 'BRAND_000000_SUB'
    WHEN 'trial2' THEN 'BRAND_000000_SUB'
    WHEN 'trial3' THEN 'BRAND_000000_SUB'
    WHEN 'trial4' THEN 'BRAND_000000_SUB'
    WHEN 'trial_monthly' THEN 'BRAND_000000_SUB'
    WHEN 'special_1eur' THEN 'BRAND_000000_SUB'
    WHEN 'special_free' THEN 'BRAND_000000_SUB'
    WHEN 'oto1_lifetime' THEN 'BRANDLIFETIME_000000_SUB'
    WHEN 'oto2_addon_weekly' THEN 'BRANDADDON_000000_SUB'
    WHEN 'oto3_bundle_all' THEN 'BRANDBUNDLE_000000_PDF'
    WHEN 'oto3_bundle_1' THEN 'BRANDBUNDLE1_000000_PDF'
    WHEN 'oto3_bundle_2' THEN 'BRANDBUNDLE2_000000_PDF'
    WHEN 'oto3_bundle_3' THEN 'BRANDBUNDLE3_000000_PDF'
    WHEN 'oto4_pdf' THEN 'BRANDPDF4_000000_PDF'
    WHEN 'oto5_pdf' THEN 'BRANDPDF5_000000_PDF'
    WHEN 'oto6_pdf' THEN 'BRANDPDF6_000000_PDF'
    WHEN 'oto7_pdf' THEN 'BRANDPDF7_000000_PDF'
    ELSE NULL
  END;
  v_expected_prefix := CASE
    WHEN p_order.session_id IS NOT NULL THEN p_order.session_id::TEXT
    WHEN p_order.user_id IS NOT NULL THEN 'u-' || p_order.user_id::TEXT
    ELSE NULL
  END;
  v_expected_variant := CASE
    WHEN p_order.session_id IS NULL THEN 'member_area'
    WHEN v_expected_code = 'BRAND_000000_SUB' THEN CASE v_internal_slug
      WHEN 'special_1eur' THEN 'special_1eur'
      WHEN 'special_free' THEN 'special_free'
      ELSE 'main'
    END
    WHEN v_internal_slug = 'oto1_lifetime' THEN 'oto1'
    WHEN v_internal_slug = 'oto2_addon_weekly' THEN 'oto2'
    WHEN v_internal_slug IN (
      'oto3_bundle_all', 'oto3_bundle_1',
      'oto3_bundle_2', 'oto3_bundle_3'
    ) THEN 'oto3'
    WHEN v_internal_slug = 'oto4_pdf' THEN 'oto4'
    WHEN v_internal_slug = 'oto5_pdf' THEN 'oto5'
    WHEN v_internal_slug = 'oto6_pdf' THEN 'oto6'
    WHEN v_internal_slug = 'oto7_pdf' THEN 'oto7'
    ELSE NULL
  END;
  v_is_catalog_subscription := v_expected_code IN (
    'BRAND_000000_SUB', 'BRANDADDON_000000_SUB'
  );

  RETURN v_expected_code IS NOT NULL
    AND v_expected_prefix IS NOT NULL
    AND p_order.product_slug = v_expected_code
    AND pg_catalog.split_part(p_order.solidgate_order_id, ':', 1) = v_expected_prefix
    AND pg_catalog.split_part(p_order.solidgate_order_id, ':', 2) = v_internal_slug
    AND pg_catalog.split_part(p_order.solidgate_order_id, ':', 3) ~ '^[1-9][0-9]{0,8}$'
    AND pg_catalog.split_part(p_order.solidgate_order_id, ':', 4) = ''
    AND v_metadata ->> 'session_id' = v_expected_prefix
    AND v_metadata ->> 'funnel_code' = CASE
      WHEN p_order.session_id IS NULL THEN 'PWA'
      ELSE 'BRAND'
    END
    AND v_metadata ->> 'funnel_variant' = v_expected_variant
    AND CASE WHEN v_is_catalog_subscription THEN
      NULLIF(BTRIM(v_metadata ->> 'price_id'), '') IS NOT NULL
      AND NOT (v_metadata ? 'locale')
    ELSE
      NULLIF(BTRIM(v_metadata ->> 'locale'), '') IS NOT NULL
      AND NOT (v_metadata ? 'price_id')
    END;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_solidgate_main_checkout_identity(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_product_slug TEXT
)
RETURNS TABLE (
  order_db_id UUID,
  offer_slug TEXT,
  customer_email TEXT,
  checkout_locale TEXT,
  solidgate_product_id TEXT,
  solidgate_payment_action TEXT,
  amount_cents INTEGER,
  currency TEXT,
  tracking_metadata JSONB,
  user_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_state public.solidgate_main_checkout_states%ROWTYPE;
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT state.*
  INTO v_state
  FROM public.solidgate_main_checkout_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.session_id = p_session_id
    AND state.product_slug = p_product_slug;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = v_state.order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.session_id = p_session_id
    AND candidate.product_slug = p_product_slug
    AND candidate.psp = 'solidgate';

  IF v_order.status = 'failed'
     AND v_order.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok') THEN
    RETURN;
  END IF;

  IF v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_customer_email IS NULL
     OR v_order.solidgate_checkout_locale IS NULL
     OR v_order.solidgate_checkout_identity_bound_at IS NULL THEN
    RAISE EXCEPTION 'legacy Solidgate main checkout identity requires provider reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT
    v_order.id,
    v_state.offer_slug,
    v_order.solidgate_customer_email,
    v_order.solidgate_checkout_locale,
    v_order.solidgate_product_id,
    v_order.solidgate_payment_action,
    v_order.amount_cents,
    v_order.currency,
    v_order.tracking_metadata,
    v_order.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_solidgate_pwa_checkout_identity(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_product_slug TEXT
)
RETURNS TABLE (
  order_db_id UUID,
  offer_slug TEXT,
  customer_email TEXT,
  checkout_locale TEXT,
  solidgate_product_id TEXT,
  solidgate_payment_action TEXT,
  amount_cents INTEGER,
  currency TEXT,
  tracking_metadata JSONB,
  purchase_mode TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = v_state.order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.session_id IS NULL
    AND candidate.product_slug = p_product_slug
    AND candidate.psp = 'solidgate';

  IF v_order.status IN ('canceled', 'expired', 'refunded')
     OR (
       v_order.status = 'failed'
       AND v_order.amount_cents = 0
       AND COALESCE(v_order.solidgate_original_amount_cents, v_order.amount_cents) > 0
       AND v_order.solidgate_payment_status IN (
         'auth_failed', 'declined', 'void_ok', 'request_rejected'
       )
     ) THEN
    RETURN;
  END IF;

  IF v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_customer_email IS NULL
     OR v_order.solidgate_checkout_locale IS NULL
     OR v_order.solidgate_checkout_identity_bound_at IS NULL THEN
    RAISE EXCEPTION 'legacy Solidgate PWA checkout identity requires provider reconciliation'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT
    v_order.id,
    v_state.offer_slug,
    v_order.solidgate_customer_email,
    v_order.solidgate_checkout_locale,
    v_order.solidgate_product_id,
    v_order.solidgate_payment_action,
    v_order.amount_cents,
    v_order.currency,
    v_order.tracking_metadata,
    v_state.purchase_mode;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_solidgate_main_checkout(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_product_name TEXT,
  p_tracking_metadata JSONB,
  p_builder_token UUID,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  order_db_id UUID,
  solidgate_order_id TEXT,
  bound_session_id UUID,
  bound_payment_environment TEXT,
  bound_product_slug TEXT,
  bound_product_name TEXT,
  bound_offer_slug TEXT,
  bound_amount_cents INTEGER,
  bound_currency TEXT,
  bound_order_status TEXT,
  bound_payment_status TEXT,
  bound_tracking_metadata JSONB,
  is_new BOOLEAN,
  should_build BOOLEAN,
  merchant_data JSONB
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_selected public.orders%ROWTYPE;
  v_state public.solidgate_main_checkout_states%ROWTYPE;
  v_expected_prefix TEXT;
  v_attempt_text TEXT;
  v_attempt INTEGER;
  v_max_attempt INTEGER := 0;
  v_open_count INTEGER := 0;
  v_has_nonretryable BOOLEAN := FALSE;
  v_is_new BOOLEAN := FALSE;
  v_should_build BOOLEAN := FALSE;
BEGIN
  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL
     OR p_offer_slug IS NULL
     OR p_offer_slug NOT IN (
       'trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free'
     )
     OR p_product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR p_product_name IS DISTINCT FROM p_product_slug
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_amount_cents IS DISTINCT FROM public.solidgate_main_checkout_amount(
          p_offer_slug,
          p_currency
        )
     OR p_builder_token IS NULL
     OR p_tracking_metadata IS NULL
     OR jsonb_typeof(p_tracking_metadata) <> 'object'
     OR p_tracking_metadata ->> 'session_id' IS DISTINCT FROM p_session_id::TEXT
     OR p_tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR p_tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
     OR NULLIF(BTRIM(p_tracking_metadata ->> 'funnel_variant'), '') IS NULL
     OR NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid canonical Solidgate main checkout binding'
      USING ERRCODE = '22023';
  END IF;

  -- hashtextextended returns one bigint key. Hash collisions only serialize
  -- unrelated checkouts; they cannot weaken exclusivity.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_payment_environment || ':' || p_session_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  v_expected_prefix := p_session_id::TEXT || ':' || p_offer_slug || ':';

  -- Include both canonical-product rows and rows already using this exact
  -- order-id namespace. The latter makes a product-column mismatch loud rather
  -- than allowing a second payable row beside corrupted data.
  FOR v_order IN
    SELECT candidate.*
    FROM public.orders AS candidate
    WHERE candidate.payment_environment = p_payment_environment
      AND candidate.session_id = p_session_id
      AND candidate.psp = 'solidgate'
      AND (
        candidate.product_slug = p_product_slug
        OR LEFT(candidate.solidgate_order_id, LENGTH(v_expected_prefix)) = v_expected_prefix
      )
    ORDER BY candidate.created_at, candidate.id
    FOR UPDATE
  LOOP
    IF v_order.solidgate_original_amount_cents IS NULL THEN
      UPDATE public.orders AS existing
      SET solidgate_original_amount_cents = p_amount_cents
      WHERE existing.id = v_order.id
        AND existing.solidgate_original_amount_cents IS NULL
      RETURNING existing.* INTO v_order;
    END IF;

    IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
       OR v_order.session_id IS DISTINCT FROM p_session_id
       OR v_order.psp IS DISTINCT FROM 'solidgate'
       OR v_order.product_slug IS DISTINCT FROM p_product_slug
       OR v_order.product_name IS DISTINCT FROM p_product_name
       OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
       OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
       OR v_order.solidgate_order_id IS NULL
       OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
            IS DISTINCT FROM v_expected_prefix
       OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM p_session_id::TEXT
       OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
       OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
       OR v_order.tracking_metadata ->> 'funnel_variant'
            IS DISTINCT FROM p_tracking_metadata ->> 'funnel_variant'
       OR v_order.tracking_metadata ->> 'price_id'
            IS DISTINCT FROM p_tracking_metadata ->> 'price_id'
       OR (
         v_order.user_id IS NOT NULL
         AND p_user_id IS NOT NULL
         AND v_order.user_id IS DISTINCT FROM p_user_id
       ) THEN
      RAISE EXCEPTION 'existing Solidgate main order binding mismatch'
        USING ERRCODE = '23514';
    END IF;

    v_attempt_text := SUBSTRING(
      v_order.solidgate_order_id
      FROM LENGTH(v_expected_prefix) + 1
    );
    IF v_attempt_text !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'invalid existing Solidgate main order id'
        USING ERRCODE = '23514';
    END IF;
    v_attempt := v_attempt_text::INTEGER;
    v_max_attempt := GREATEST(v_max_attempt, v_attempt);

    IF v_order.status = 'pending' THEN
      -- A terminal provider state and a payable local state cannot both be
      -- true. Refuse the contradiction instead of guessing which one won.
      IF v_order.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok') THEN
        RAISE EXCEPTION 'inconsistent terminal Solidgate main order state'
          USING ERRCODE = '23514';
      END IF;
      v_open_count := v_open_count + 1;
      v_selected := v_order;
    ELSIF v_order.status = 'failed' THEN
      -- A local `failed` flag alone is insufficient: confirmation may classify
      -- an under-captured/unknown state as failed even though a later callback
      -- can still settle it. Advance only on an explicit terminal PSP state.
      IF v_order.solidgate_payment_status IS NULL
         OR v_order.solidgate_payment_status NOT IN ('auth_failed', 'declined', 'void_ok') THEN
        RAISE EXCEPTION 'failed Solidgate main order is not terminal'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      -- completed/trialing/active/past_due and all reversal/cancellation states
      -- are never a reason to issue another introductory payable order.
      v_has_nonretryable := TRUE;
    END IF;
  END LOOP;

  IF v_open_count > 1 THEN
    RAISE EXCEPTION 'multiple payable Solidgate main orders already exist'
      USING ERRCODE = '23505';
  END IF;
  IF v_has_nonretryable THEN
    RAISE EXCEPTION 'Solidgate main checkout is not retryable'
      USING ERRCODE = '23514';
  END IF;

  IF v_open_count = 0 THEN
    v_attempt := v_max_attempt + 1;
    IF v_attempt < 1 OR v_attempt > 999999999 THEN
      RAISE EXCEPTION 'Solidgate main checkout attempt exhausted'
        USING ERRCODE = '22003';
    END IF;

    -- Deliberately no ON CONFLICT loop. The advisory lock makes this exact
    -- allocation exclusive; a duplicate means data or a non-RPC writer broke
    -- the invariant and must fail the request closed.
    INSERT INTO public.orders (
      psp,
      payment_environment,
      solidgate_order_id,
      session_id,
      user_id,
      status,
      amount_cents,
      currency,
      product_name,
      product_slug,
      solidgate_original_amount_cents,
      tracking_metadata
    ) VALUES (
      'solidgate',
      p_payment_environment,
      v_expected_prefix || v_attempt::TEXT,
      p_session_id,
      p_user_id,
      'pending',
      p_amount_cents,
      p_currency,
      p_product_name,
      p_product_slug,
      p_amount_cents,
      p_tracking_metadata
    )
    RETURNING * INTO v_selected;
    v_is_new := TRUE;
  ELSIF v_selected.user_id IS NULL AND p_user_id IS NOT NULL THEN
    UPDATE public.orders AS existing
    SET user_id = p_user_id
    WHERE existing.id = v_selected.id
      AND existing.user_id IS NULL
    RETURNING existing.* INTO v_selected;
  END IF;

  INSERT INTO public.solidgate_main_checkout_states (
    payment_environment,
    session_id,
    product_slug,
    offer_slug,
    order_db_id,
    builder_token,
    build_started_at
  ) VALUES (
    p_payment_environment,
    p_session_id,
    p_product_slug,
    p_offer_slug,
    v_selected.id,
    p_builder_token,
    NOW()
  )
  ON CONFLICT (payment_environment, session_id, product_slug) DO NOTHING;

  SELECT checkout.*
  INTO STRICT v_state
  FROM public.solidgate_main_checkout_states AS checkout
  WHERE checkout.payment_environment = p_payment_environment
    AND checkout.session_id = p_session_id
    AND checkout.product_slug = p_product_slug
  FOR UPDATE;

  IF v_state.order_db_id IS DISTINCT FROM v_selected.id THEN
    -- A definitively failed attempt advanced to a new order under the same
    -- serialized key. Its old encrypted payload must never follow it.
    UPDATE public.solidgate_main_checkout_states AS checkout
    SET offer_slug = p_offer_slug,
        order_db_id = v_selected.id,
        builder_token = p_builder_token,
        build_started_at = NOW(),
        merchant_data = NULL,
        updated_at = NOW()
    WHERE checkout.payment_environment = p_payment_environment
      AND checkout.session_id = p_session_id
      AND checkout.product_slug = p_product_slug
    RETURNING checkout.* INTO v_state;
    v_should_build := TRUE;
  ELSIF v_state.offer_slug IS DISTINCT FROM p_offer_slug THEN
    RAISE EXCEPTION 'Solidgate main checkout offer binding mismatch'
      USING ERRCODE = '23514';
  ELSIF v_state.merchant_data IS NOT NULL THEN
    v_should_build := FALSE;
  ELSIF v_state.builder_token = p_builder_token THEN
    v_should_build := TRUE;
  ELSIF v_state.build_started_at < NOW() - INTERVAL '30 seconds' THEN
    -- Recover a builder that died after reserving the order. This may rebuild
    -- encryption for the SAME order id; it never creates another payable row.
    UPDATE public.solidgate_main_checkout_states AS checkout
    SET builder_token = p_builder_token,
        build_started_at = NOW(),
        updated_at = NOW()
    WHERE checkout.payment_environment = p_payment_environment
      AND checkout.session_id = p_session_id
      AND checkout.product_slug = p_product_slug
    RETURNING checkout.* INTO v_state;
    v_should_build := TRUE;
  END IF;

  RETURN QUERY SELECT
    v_selected.id,
    v_selected.solidgate_order_id,
    v_selected.session_id,
    v_selected.payment_environment,
    v_selected.product_slug,
    v_selected.product_name,
    v_state.offer_slug,
    v_selected.solidgate_original_amount_cents,
    LOWER(v_selected.currency),
    v_selected.status,
    v_selected.solidgate_payment_status,
    v_selected.tracking_metadata,
    v_is_new,
    v_should_build,
    v_state.merchant_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_solidgate_main_checkout_v2(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_product_name TEXT,
  p_tracking_metadata JSONB,
  p_builder_token UUID,
  p_customer_email TEXT,
  p_checkout_locale TEXT,
  p_solidgate_product_id TEXT,
  p_solidgate_payment_action TEXT,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  order_db_id UUID,
  solidgate_order_id TEXT,
  bound_session_id UUID,
  bound_payment_environment TEXT,
  bound_product_slug TEXT,
  bound_product_name TEXT,
  bound_offer_slug TEXT,
  bound_amount_cents INTEGER,
  bound_currency TEXT,
  bound_order_status TEXT,
  bound_payment_status TEXT,
  bound_tracking_metadata JSONB,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  bound_solidgate_product_id TEXT,
  bound_solidgate_payment_action TEXT,
  is_new BOOLEAN,
  should_build BOOLEAN,
  merchant_data JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_opened RECORD;
  v_identity public.orders%ROWTYPE;
  v_existing_order public.orders%ROWTYPE;
  v_state public.solidgate_main_checkout_states%ROWTYPE;
  v_state_found BOOLEAN := FALSE;
  v_is_retired BOOLEAN := FALSE;
  v_should_build BOOLEAN := FALSE;
  v_attempt INTEGER;
  v_new_order public.orders%ROWTYPE;
  v_email TEXT := LOWER(BTRIM(COALESCE(p_customer_email, '')));
  v_locale TEXT := BTRIM(COALESCE(p_checkout_locale, ''));
  v_product_id TEXT := NULLIF(BTRIM(COALESCE(p_solidgate_product_id, '')), '');
  v_payment_action TEXT := BTRIM(COALESCE(p_solidgate_payment_action, ''));
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR CHAR_LENGTH(v_email) > 320
     OR v_locale NOT IN (
       'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
       'he', 'pl', 'hr', 'da', 'ja'
     )
     OR v_product_id IS NULL
     OR CHAR_LENGTH(v_product_id) > 255
     OR v_product_id !~ '^[[:alnum:]_-]+$'
     OR v_payment_action NOT IN ('auth_settle', 'auth_0_amount')
     OR (p_amount_cents = 0) IS DISTINCT FROM (v_payment_action = 'auth_0_amount') THEN
    RAISE EXCEPTION 'invalid Solidgate main checkout identity'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.solidgate_customer_email', v_email, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_checkout_locale', v_locale, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_product_id', v_product_id, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_payment_action', v_payment_action, TRUE);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_payment_environment || ':' || p_session_id::TEXT || ':' || p_product_slug,
      0
    )
  );
  SELECT state.*
  INTO v_state
  FROM public.solidgate_main_checkout_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.session_id = p_session_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;
  v_state_found := FOUND;

  IF v_state_found THEN
    SELECT candidate.*
    INTO STRICT v_existing_order
    FROM public.orders AS candidate
    WHERE candidate.id = v_state.order_db_id
    FOR UPDATE;
    v_is_retired := v_existing_order.status = 'failed'
      AND v_existing_order.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok');
  END IF;

  IF v_state_found AND NOT v_is_retired THEN
    IF v_state.offer_slug IS DISTINCT FROM p_offer_slug
       OR v_existing_order.payment_environment IS DISTINCT FROM p_payment_environment
       OR v_existing_order.session_id IS DISTINCT FROM p_session_id
       OR v_existing_order.psp IS DISTINCT FROM 'solidgate'
       OR v_existing_order.product_slug IS DISTINCT FROM p_product_slug
       OR v_existing_order.product_name IS DISTINCT FROM p_product_name
       OR v_existing_order.status IS DISTINCT FROM 'pending'
       OR v_existing_order.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok')
       OR v_existing_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
       OR LOWER(v_existing_order.currency) IS DISTINCT FROM p_currency
       OR v_existing_order.tracking_metadata IS DISTINCT FROM p_tracking_metadata
       OR v_existing_order.solidgate_customer_email IS DISTINCT FROM v_email
       OR v_existing_order.solidgate_checkout_locale IS DISTINCT FROM v_locale
       OR v_existing_order.solidgate_product_id IS DISTINCT FROM v_product_id
       OR v_existing_order.solidgate_payment_action IS DISTINCT FROM v_payment_action
       OR v_existing_order.solidgate_checkout_identity_legacy
       OR (
         v_existing_order.user_id IS NOT NULL
         AND p_user_id IS NOT NULL
         AND v_existing_order.user_id IS DISTINCT FROM p_user_id
       ) THEN
      RAISE EXCEPTION 'existing Solidgate main checkout snapshot mismatch'
        USING ERRCODE = '23514';
    END IF;

    IF v_state.merchant_data IS NULL THEN
      IF v_state.builder_token = p_builder_token THEN
        v_should_build := TRUE;
      ELSIF v_state.build_started_at < NOW() - INTERVAL '30 seconds' THEN
        UPDATE public.solidgate_main_checkout_states AS state
        SET builder_token = p_builder_token,
            build_started_at = NOW(),
            updated_at = NOW()
        WHERE state.payment_environment = p_payment_environment
          AND state.session_id = p_session_id
          AND state.product_slug = p_product_slug
        RETURNING state.* INTO v_state;
        v_should_build := TRUE;
      END IF;
    END IF;

    SELECT
      v_existing_order.id AS order_db_id,
      v_existing_order.solidgate_order_id AS solidgate_order_id,
      v_existing_order.session_id AS bound_session_id,
      v_existing_order.payment_environment AS bound_payment_environment,
      v_existing_order.product_slug AS bound_product_slug,
      v_existing_order.product_name AS bound_product_name,
      v_state.offer_slug AS bound_offer_slug,
      v_existing_order.solidgate_original_amount_cents AS bound_amount_cents,
      LOWER(v_existing_order.currency) AS bound_currency,
      v_existing_order.status AS bound_order_status,
      v_existing_order.solidgate_payment_status AS bound_payment_status,
      v_existing_order.tracking_metadata AS bound_tracking_metadata,
      FALSE AS is_new,
      v_should_build AS should_build,
      v_state.merchant_data AS merchant_data
    INTO STRICT v_opened;
  ELSIF v_state_found AND v_is_retired THEN
    IF EXISTS (
      SELECT 1
      FROM public.orders AS candidate
      WHERE candidate.payment_environment = p_payment_environment
        AND candidate.session_id = p_session_id
        AND candidate.psp = 'solidgate'
        AND candidate.product_slug = p_product_slug
        AND NOT (
          candidate.status = 'failed'
          AND candidate.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok')
        )
    ) THEN
      RAISE EXCEPTION 'Solidgate main checkout is not retryable'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(MAX(
      CASE
        WHEN pg_catalog.split_part(candidate.solidgate_order_id, ':', 3)
               ~ '^[1-9][0-9]{0,8}$'
        THEN pg_catalog.split_part(candidate.solidgate_order_id, ':', 3)::INTEGER
        ELSE NULL
      END
    ), 0) + 1
    INTO v_attempt
    FROM public.orders AS candidate
    WHERE candidate.payment_environment = p_payment_environment
      AND candidate.session_id = p_session_id
      AND candidate.psp = 'solidgate'
      AND candidate.product_slug = p_product_slug;
    IF v_attempt < 1 OR v_attempt > 999999999 THEN
      RAISE EXCEPTION 'Solidgate main checkout attempt exhausted'
        USING ERRCODE = '22003';
    END IF;

    INSERT INTO public.orders (
      psp, payment_environment, solidgate_order_id, session_id, user_id,
      status, amount_cents, currency, product_name, product_slug,
      solidgate_original_amount_cents, tracking_metadata
    ) VALUES (
      'solidgate', p_payment_environment,
      p_session_id::TEXT || ':' || p_offer_slug || ':' || v_attempt::TEXT,
      p_session_id, p_user_id, 'pending', p_amount_cents, p_currency,
      p_product_name, p_product_slug, p_amount_cents, p_tracking_metadata
    )
    RETURNING * INTO v_new_order;

    UPDATE public.solidgate_main_checkout_states AS state
    SET offer_slug = p_offer_slug,
        order_db_id = v_new_order.id,
        builder_token = p_builder_token,
        build_started_at = NOW(),
        merchant_data = NULL,
        updated_at = NOW()
    WHERE state.payment_environment = p_payment_environment
      AND state.session_id = p_session_id
      AND state.product_slug = p_product_slug
    RETURNING state.* INTO v_state;

    SELECT
      v_new_order.id AS order_db_id,
      v_new_order.solidgate_order_id AS solidgate_order_id,
      v_new_order.session_id AS bound_session_id,
      v_new_order.payment_environment AS bound_payment_environment,
      v_new_order.product_slug AS bound_product_slug,
      v_new_order.product_name AS bound_product_name,
      v_state.offer_slug AS bound_offer_slug,
      v_new_order.solidgate_original_amount_cents AS bound_amount_cents,
      LOWER(v_new_order.currency) AS bound_currency,
      v_new_order.status AS bound_order_status,
      v_new_order.solidgate_payment_status AS bound_payment_status,
      v_new_order.tracking_metadata AS bound_tracking_metadata,
      TRUE AS is_new,
      TRUE AS should_build,
      v_state.merchant_data AS merchant_data
    INTO STRICT v_opened;
  ELSE
    SELECT opened.*
    INTO STRICT v_opened
    FROM public.open_solidgate_main_checkout(
      p_payment_environment,
      p_session_id,
      p_offer_slug,
      p_product_slug,
      p_amount_cents,
      p_currency,
      p_product_name,
      p_tracking_metadata,
      p_builder_token,
      p_user_id
    ) AS opened;
  END IF;

  SELECT candidate.*
  INTO STRICT v_identity
  FROM public.orders AS candidate
  WHERE candidate.id = v_opened.order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.solidgate_order_id = v_opened.solidgate_order_id
    AND candidate.session_id = p_session_id
    AND candidate.psp = 'solidgate'
  FOR SHARE;

  IF v_identity.solidgate_checkout_identity_legacy
     OR v_identity.solidgate_customer_email IS NULL
     OR v_identity.solidgate_checkout_locale IS NULL
     OR v_identity.solidgate_product_id IS NULL
     OR v_identity.solidgate_payment_action IS DISTINCT FROM v_payment_action
     OR v_identity.solidgate_checkout_identity_bound_at IS NULL THEN
    RAISE EXCEPTION 'legacy Solidgate main checkout identity requires provider reconciliation'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config('app.solidgate_customer_email', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_checkout_locale', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_product_id', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_payment_action', '', TRUE);

  RETURN QUERY SELECT
    v_opened.order_db_id::UUID,
    v_opened.solidgate_order_id::TEXT,
    v_opened.bound_session_id::UUID,
    v_opened.bound_payment_environment::TEXT,
    v_opened.bound_product_slug::TEXT,
    v_opened.bound_product_name::TEXT,
    v_opened.bound_offer_slug::TEXT,
    v_opened.bound_amount_cents::INTEGER,
    v_opened.bound_currency::TEXT,
    v_opened.bound_order_status::TEXT,
    v_opened.bound_payment_status::TEXT,
    v_opened.bound_tracking_metadata::JSONB,
    v_identity.solidgate_customer_email,
    v_identity.solidgate_checkout_locale,
    v_identity.solidgate_product_id,
    v_identity.solidgate_payment_action,
    v_opened.is_new::BOOLEAN,
    v_opened.should_build::BOOLEAN,
    v_opened.merchant_data::JSONB;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_main_checkout(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_builder_token UUID,
  p_merchant_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_main_checkout_states%ROWTYPE;
BEGIN
  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL
     OR p_offer_slug IS NULL
     OR p_offer_slug NOT IN (
       'trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free'
     )
     OR p_product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_amount_cents IS DISTINCT FROM public.solidgate_main_checkout_amount(
          p_offer_slug,
          p_currency
        )
     OR p_builder_token IS NULL
     OR p_merchant_data IS NULL
     OR jsonb_typeof(p_merchant_data) <> 'object'
     OR jsonb_typeof(p_merchant_data -> 'merchant') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'paymentIntent') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'signature') <> 'string'
     OR NULLIF(BTRIM(p_merchant_data ->> 'merchant'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'paymentIntent'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'signature'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate main merchant data finalization'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_payment_environment || ':' || p_session_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.session_id IS DISTINCT FROM p_session_id
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(
          v_order.solidgate_order_id,
          LENGTH(p_session_id::TEXT || ':' || p_offer_slug || ':')
        ) IS DISTINCT FROM (p_session_id::TEXT || ':' || p_offer_slug || ':')
     OR SUBSTRING(
          v_order.solidgate_order_id
          FROM LENGTH(p_session_id::TEXT || ':' || p_offer_slug || ':') + 1
        ) !~ '^[1-9][0-9]{0,8}$'
     OR v_order.status IS DISTINCT FROM 'pending'
     OR v_order.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok')
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM p_session_id::TEXT
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug THEN
    RAISE EXCEPTION 'Solidgate main order changed before finalization'
      USING ERRCODE = '23514';
  END IF;

  SELECT checkout.*
  INTO STRICT v_state
  FROM public.solidgate_main_checkout_states AS checkout
  WHERE checkout.payment_environment = p_payment_environment
    AND checkout.session_id = p_session_id
    AND checkout.product_slug = p_product_slug
  FOR UPDATE;

  IF v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.builder_token IS DISTINCT FROM p_builder_token THEN
    RAISE EXCEPTION 'Solidgate main checkout builder lost ownership'
      USING ERRCODE = '40001';
  END IF;

  IF v_state.merchant_data IS NULL THEN
    UPDATE public.solidgate_main_checkout_states AS checkout
    SET merchant_data = p_merchant_data,
        updated_at = NOW()
    WHERE checkout.payment_environment = p_payment_environment
      AND checkout.session_id = p_session_id
      AND checkout.product_slug = p_product_slug
    RETURNING checkout.* INTO v_state;
  ELSIF v_state.merchant_data IS DISTINCT FROM p_merchant_data THEN
    RAISE EXCEPTION 'Solidgate main checkout already finalized differently'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_state.merchant_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_main_checkout_v2(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_builder_token UUID,
  p_merchant_data JSONB,
  p_customer_email TEXT,
  p_checkout_locale TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_identity public.orders%ROWTYPE;
BEGIN
  SELECT candidate.*
  INTO STRICT v_identity
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.session_id = p_session_id
    AND candidate.psp = 'solidgate'
  FOR SHARE;

  IF v_identity.solidgate_checkout_identity_legacy
     OR v_identity.solidgate_customer_email
          IS DISTINCT FROM LOWER(BTRIM(COALESCE(p_customer_email, '')))
     OR v_identity.solidgate_checkout_locale
          IS DISTINCT FROM BTRIM(COALESCE(p_checkout_locale, '')) THEN
    RAISE EXCEPTION 'Solidgate main checkout identity changed before finalization'
      USING ERRCODE = '23514';
  END IF;

  RETURN public.finalize_solidgate_main_checkout(
    p_payment_environment,
    p_session_id,
    p_offer_slug,
    p_product_slug,
    p_order_db_id,
    p_solidgate_order_id,
    p_amount_cents,
    p_currency,
    p_builder_token,
    p_merchant_data
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.open_solidgate_oto_order_v2(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_product_slug TEXT,
  p_order_prefix TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_product_name TEXT,
  p_tracking_metadata JSONB,
  p_customer_email TEXT,
  p_checkout_locale TEXT,
  p_builder_token UUID,
  p_user_id UUID DEFAULT NULL,
  p_solidgate_product_id TEXT DEFAULT NULL,
  p_solidgate_payment_action TEXT DEFAULT 'auth_settle'
)
RETURNS TABLE (
  order_db_id UUID,
  solidgate_order_id TEXT,
  order_status TEXT,
  solidgate_payment_status TEXT,
  is_new BOOLEAN,
  should_submit BOOLEAN,
  needs_reconcile BOOLEAN,
  claim_token UUID,
  bound_original_amount_cents INTEGER,
  bound_currency TEXT,
  bound_tracking_metadata JSONB,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  bound_solidgate_product_id TEXT,
  bound_solidgate_payment_action TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_selected public.orders%ROWTYPE;
  v_nonterminal_count INTEGER := 0;
  v_attempt_text TEXT;
  v_attempt INTEGER;
  v_max_attempt INTEGER := 0;
  v_internal_slug TEXT;
  v_row_internal_slug TEXT;
  v_requested_step INTEGER;
  v_product_step INTEGER;
  v_row_product_step INTEGER;
  v_row_slug_step INTEGER;
  v_persisted_step INTEGER;
  v_oto_environment TEXT;
  v_is_live BOOLEAN;
  v_is_new BOOLEAN := FALSE;
  v_should_submit BOOLEAN := FALSE;
  v_needs_reconcile BOOLEAN := FALSE;
  v_claim_token UUID;
  v_solidgate_product_id TEXT := NULLIF(BTRIM(COALESCE(p_solidgate_product_id, '')), '');
  v_payment_action TEXT := BTRIM(COALESCE(p_solidgate_payment_action, ''));
BEGIN
  v_internal_slug := pg_catalog.split_part(p_order_prefix, ':', 2);
  v_requested_step := public.solidgate_oto_step_from_internal_slug(v_internal_slug);
  v_product_step := public.solidgate_oto_step_from_product_slug(p_product_slug);
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL
     OR p_product_slug IS NULL
     OR p_product_name IS DISTINCT FROM p_product_slug
     OR p_order_prefix IS DISTINCT FROM (p_session_id::TEXT || ':' || v_internal_slug)
     OR v_requested_step IS NULL
     OR v_product_step IS NULL
     OR v_requested_step IS DISTINCT FROM v_product_step
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_tracking_metadata IS NULL
     OR jsonb_typeof(p_tracking_metadata) <> 'object'
     OR p_tracking_metadata ->> 'session_id' IS DISTINCT FROM p_session_id::TEXT
     OR p_tracking_metadata ->> 'product_slug' IS DISTINCT FROM v_internal_slug
     OR p_tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
     OR p_tracking_metadata ->> 'funnel_variant'
          IS DISTINCT FROM ('oto' || v_requested_step::TEXT)
     OR (
       v_requested_step = 2
       AND (
         NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NULL
         OR p_tracking_metadata ? 'locale'
         OR v_solidgate_product_id IS NULL
       )
     )
     OR (
       v_requested_step <> 2
       AND (
         NULLIF(BTRIM(p_tracking_metadata ->> 'locale'), '') IS NULL
         OR p_tracking_metadata ->> 'locale'
              IS DISTINCT FROM BTRIM(p_checkout_locale)
         OR p_tracking_metadata ? 'price_id'
         OR v_solidgate_product_id IS NOT NULL
       )
     )
     OR (
       v_solidgate_product_id IS NOT NULL
       AND (
         CHAR_LENGTH(v_solidgate_product_id) > 255
         OR v_solidgate_product_id !~ '^[[:alnum:]_-]+$'
       )
     )
     OR v_payment_action IS DISTINCT FROM 'auth_settle'
     OR NULLIF(BTRIM(p_customer_email), '') IS NULL
     OR NULLIF(BTRIM(p_checkout_locale), '') IS NULL
     OR p_builder_token IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid canonical Solidgate OTO binding';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_payment_environment || ':' || p_session_id::TEXT || ':oto-step:' ||
        v_requested_step::TEXT,
      0
    )
  );

  SELECT
    public.solidgate_persisted_oto_step(session_row.last_oto_step),
    session_row.solidgate_oto_environment
  INTO v_persisted_step, v_oto_environment
  FROM public.sessions AS session_row
  WHERE session_row.id = p_session_id
  FOR UPDATE;
  IF NOT FOUND OR v_persisted_step IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid persisted OTO step';
  END IF;
  IF v_oto_environment IS NULL THEN
    UPDATE public.sessions AS session_row
    SET solidgate_oto_environment = p_payment_environment,
        updated_at = NOW()
    WHERE session_row.id = p_session_id;
  ELSIF v_oto_environment IS DISTINCT FROM p_payment_environment THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'oto_progress_environment_mismatch';
  END IF;

  -- Scan the whole funnel step, not only the requested provider product.  An
  -- exact row remains retryable even after accepted progress moved forward;
  -- any other live/captured choice at this step owns the step and blocks a
  -- second charge.
  FOR v_order IN
    SELECT candidate.*
    FROM public.orders AS candidate
    WHERE candidate.payment_environment = p_payment_environment
      AND candidate.session_id = p_session_id
      AND candidate.psp = 'solidgate'
      AND (
        public.solidgate_oto_step_from_product_slug(candidate.product_slug)
          = v_requested_step
        OR public.solidgate_oto_step_from_internal_slug(
             pg_catalog.split_part(candidate.solidgate_order_id, ':', 2)
           ) = v_requested_step
      )
    ORDER BY candidate.created_at, candidate.id
    FOR UPDATE
  LOOP
    v_row_internal_slug := pg_catalog.split_part(v_order.solidgate_order_id, ':', 2);
    v_row_product_step := public.solidgate_oto_step_from_product_slug(v_order.product_slug);
    v_row_slug_step := public.solidgate_oto_step_from_internal_slug(v_row_internal_slug);
    IF v_order.product_name IS DISTINCT FROM v_order.product_slug
       OR v_order.solidgate_order_id IS NULL
       OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 1)
            IS DISTINCT FROM p_session_id::TEXT
       OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 3)
            !~ '^[1-9][0-9]{0,8}$'
       OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 4) <> ''
       OR v_row_product_step IS NULL
       OR v_row_slug_step IS NULL
       OR v_row_product_step IS DISTINCT FROM v_requested_step
       OR v_row_slug_step IS DISTINCT FROM v_requested_step THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'existing Solidgate OTO order binding mismatch';
    END IF;

    IF v_row_internal_slug = v_internal_slug
       AND v_order.product_slug = p_product_slug THEN
      v_attempt_text := pg_catalog.split_part(v_order.solidgate_order_id, ':', 3);
      v_attempt := v_attempt_text::INTEGER;
      v_max_attempt := GREATEST(v_max_attempt, v_attempt);
    END IF;

    v_is_live := v_order.status IS DISTINCT FROM 'failed'
      OR v_order.amount_cents IS DISTINCT FROM 0
      OR v_order.solidgate_payment_status IS NULL
      OR v_order.solidgate_payment_status
           NOT IN ('auth_failed', 'declined', 'void_ok', 'request_rejected');

    IF v_is_live THEN
      -- Once an order may have reached the PSP, every recovery input comes
      -- from this immutable row. Fresh session UTM/email/locale are deliberately
      -- not compared: they are mutable and cannot redefine an existing charge.
      IF v_order.solidgate_original_amount_cents IS NULL
         OR v_order.solidgate_original_amount_cents < 0
         OR LOWER(v_order.currency) !~ '^[a-z]{3}$'
         OR v_order.tracking_metadata IS NULL
         OR jsonb_typeof(v_order.tracking_metadata) <> 'object'
         OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM p_session_id::TEXT
         OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM v_row_internal_slug
         OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
         OR v_order.tracking_metadata ->> 'funnel_variant'
              IS DISTINCT FROM ('oto' || v_requested_step::TEXT)
         OR (
           v_requested_step = 2
           AND (
             NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NULL
             OR v_order.tracking_metadata ? 'locale'
             OR NULLIF(BTRIM(v_order.solidgate_product_id), '') IS NULL
           )
         )
         OR (
           v_requested_step <> 2
           AND (
             NULLIF(BTRIM(v_order.tracking_metadata ->> 'locale'), '') IS NULL
             OR v_order.tracking_metadata ->> 'locale'
                  IS DISTINCT FROM v_order.solidgate_checkout_locale
             OR v_order.tracking_metadata ? 'price_id'
             OR v_order.solidgate_product_id IS NOT NULL
           )
         )
         OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
         OR NULLIF(BTRIM(v_order.solidgate_customer_email), '') IS NULL
         OR NULLIF(BTRIM(v_order.solidgate_checkout_locale), '') IS NULL
         OR v_order.solidgate_checkout_identity_legacy THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'existing Solidgate OTO immutable binding mismatch';
      END IF;

      IF v_row_internal_slug IS DISTINCT FROM v_internal_slug
         OR v_order.product_slug IS DISTINCT FROM p_product_slug THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'oto_step_already_bound';
      END IF;
      IF v_order.user_id IS NOT NULL
         AND p_user_id IS NOT NULL
         AND v_order.user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'existing Solidgate OTO user binding mismatch';
      END IF;
      v_nonterminal_count := v_nonterminal_count + 1;
      v_selected := v_order;
    END IF;
  END LOOP;

  IF v_nonterminal_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'multiple payable or uncertain Solidgate OTO step orders already exist';
  END IF;

  IF v_nonterminal_count = 0 THEN
    IF v_persisted_step IS DISTINCT FROM v_requested_step THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'oto_progress_conflict';
    END IF;

    v_attempt := v_max_attempt + 1;
    IF v_attempt < 1 OR v_attempt > 999999999 THEN
      RAISE EXCEPTION 'Solidgate OTO attempt exhausted'
        USING ERRCODE = '22003';
    END IF;

    INSERT INTO public.orders (
      psp,
      payment_environment,
      solidgate_order_id,
      session_id,
      user_id,
      status,
      amount_cents,
      currency,
      product_name,
      product_slug,
      solidgate_original_amount_cents,
      solidgate_product_id,
      solidgate_payment_action,
      solidgate_payment_status,
      solidgate_submission_token,
      solidgate_submission_started_at,
      solidgate_customer_email,
      solidgate_checkout_locale,
      solidgate_checkout_identity_bound_at,
      solidgate_checkout_identity_legacy,
      tracking_metadata
    ) VALUES (
      'solidgate',
      p_payment_environment,
      p_order_prefix || ':' || v_attempt::TEXT,
      p_session_id,
      p_user_id,
      'pending',
      p_amount_cents,
      p_currency,
      p_product_name,
      p_product_slug,
      p_amount_cents,
      v_solidgate_product_id,
      v_payment_action,
      'creating',
      p_builder_token,
      NOW(),
      LOWER(BTRIM(p_customer_email)),
      BTRIM(p_checkout_locale),
      NOW(),
      FALSE,
      p_tracking_metadata
    )
    RETURNING * INTO v_selected;
    v_is_new := TRUE;
    v_should_submit := TRUE;
    v_claim_token := p_builder_token;
  ELSIF v_selected.user_id IS NULL AND p_user_id IS NOT NULL THEN
    UPDATE public.orders AS existing
    SET user_id = p_user_id
    WHERE existing.id = v_selected.id
      AND existing.user_id IS NULL
    RETURNING existing.* INTO v_selected;
  END IF;

  IF NOT v_is_new
     AND v_selected.status = 'pending'
     AND (
       v_selected.solidgate_payment_status IS NULL
       OR v_selected.solidgate_payment_status = 'creating'
     )
     AND COALESCE(v_selected.solidgate_submission_started_at, v_selected.created_at)
           < NOW() - INTERVAL '120 seconds' THEN
    UPDATE public.orders AS existing
    SET solidgate_payment_status = 'creating',
        solidgate_submission_token = p_builder_token,
        solidgate_submission_started_at = NOW()
    WHERE existing.id = v_selected.id
      AND existing.status = 'pending'
      AND (
        existing.solidgate_payment_status IS NULL
        OR existing.solidgate_payment_status = 'creating'
      )
      AND COALESCE(existing.solidgate_submission_started_at, existing.created_at)
            < NOW() - INTERVAL '120 seconds'
    RETURNING existing.* INTO v_selected;

    IF FOUND THEN
      v_needs_reconcile := TRUE;
      v_claim_token := p_builder_token;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_selected.id,
    v_selected.solidgate_order_id,
    v_selected.status,
    v_selected.solidgate_payment_status,
    v_is_new,
    v_should_submit,
    v_needs_reconcile,
    v_claim_token,
    v_selected.solidgate_original_amount_cents,
    LOWER(v_selected.currency),
    v_selected.tracking_metadata,
    v_selected.solidgate_customer_email,
    v_selected.solidgate_checkout_locale,
    v_selected.solidgate_product_id,
    v_selected.solidgate_payment_action;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_solidgate_oto_order_after_absent_reconcile(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_builder_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_step INTEGER;
  v_updated INTEGER := 0;
BEGIN
  v_step := public.solidgate_oto_step_from_product_slug(p_product_slug);
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL
     OR v_step IS NULL
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_builder_token IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate OTO resume binding'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_payment_environment || ':' || p_session_id::TEXT || ':oto-step:' || v_step::TEXT,
      0
    )
  );

  UPDATE public.orders AS candidate
  SET solidgate_submission_started_at = NOW()
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.session_id = p_session_id
    AND candidate.psp = 'solidgate'
    AND candidate.product_slug = p_product_slug
    AND public.solidgate_oto_step_from_product_slug(candidate.product_slug) = v_step
    AND candidate.id = p_order_db_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.status = 'pending'
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_builder_token
    AND candidate.solidgate_submission_started_at
          >= NOW() - INTERVAL '120 seconds';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_solidgate_pwa_purchase(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_tracking_metadata JSONB,
  p_requested_mode TEXT,
  p_claim_token UUID
)
RETURNS TABLE (
  order_db_id UUID,
  solidgate_order_id TEXT,
  bound_payment_environment TEXT,
  bound_user_id UUID,
  bound_offer_slug TEXT,
  bound_product_slug TEXT,
  bound_product_name TEXT,
  bound_amount_cents INTEGER,
  bound_currency TEXT,
  bound_order_status TEXT,
  bound_payment_status TEXT,
  bound_tracking_metadata JSONB,
  purchase_mode TEXT,
  solidgate_subscription_id TEXT,
  verify_url TEXT,
  last_result_kind TEXT,
  last_result_net_amount_cents INTEGER,
  is_new BOOLEAN,
  should_build BOOLEAN,
  should_submit BOOLEAN,
  needs_reconcile BOOLEAN,
  claim_token UUID,
  merchant_data JSONB
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_selected public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
  v_attempt_text TEXT;
  v_attempt INTEGER;
  v_max_attempt INTEGER := 0;
  v_open_count INTEGER := 0;
  v_price_binding TEXT;
  v_is_new BOOLEAN := FALSE;
  v_should_build BOOLEAN := FALSE;
  v_should_submit BOOLEAN := FALSE;
  v_needs_reconcile BOOLEAN := FALSE;
  v_return_claim UUID;
  v_state_inserted BOOLEAN := FALSE;
  v_state_advanced BOOLEAN := FALSE;
  v_is_retired BOOLEAN := FALSE;
  v_adopted_legacy_failed BOOLEAN := FALSE;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_tracking_metadata IS NULL
     OR jsonb_typeof(p_tracking_metadata) <> 'object'
     OR p_tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR p_tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR p_tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR p_tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR p_requested_mode IS NULL
     OR p_requested_mode NOT IN ('saved_card', 'hosted_form')
     OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'invalid canonical Solidgate PWA purchase binding'
      USING ERRCODE = '22023';
  END IF;

  IF p_offer_slug = 'oto2_addon_weekly' THEN
    v_price_binding := NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '');
    IF v_price_binding IS NULL
       OR NULLIF(BTRIM(p_tracking_metadata ->> 'locale'), '') IS NOT NULL THEN
      RAISE EXCEPTION 'invalid Solidgate PWA add-on price binding'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_price_binding := NULLIF(BTRIM(p_tracking_metadata ->> 'locale'), '');
    IF v_price_binding IS NULL
       OR NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NOT NULL THEN
      RAISE EXCEPTION 'invalid Solidgate PWA library locale binding'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  FOR v_order IN
    SELECT candidate.*
    FROM public.orders AS candidate
    WHERE candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.session_id IS NULL
      AND candidate.psp = 'solidgate'
      AND (
        candidate.product_slug = p_product_slug
        OR LEFT(candidate.solidgate_order_id, LENGTH(v_expected_prefix))
             = v_expected_prefix
      )
    ORDER BY candidate.created_at, candidate.id
    FOR UPDATE
  LOOP
    IF v_order.product_slug IS DISTINCT FROM p_product_slug
       OR v_order.product_name IS DISTINCT FROM p_product_slug
       OR COALESCE(v_order.solidgate_original_amount_cents, v_order.amount_cents) IS NULL
       OR COALESCE(v_order.solidgate_original_amount_cents, v_order.amount_cents) <= 0
       OR v_order.currency IS NULL
       OR LOWER(v_order.currency) !~ '^[a-z]{3}$'
       OR v_order.solidgate_order_id IS NULL
       OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
            IS DISTINCT FROM v_expected_prefix
       OR v_order.tracking_metadata IS NULL
       OR jsonb_typeof(v_order.tracking_metadata) <> 'object'
       OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
       OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
       OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
       OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
       OR (
         p_offer_slug = 'oto2_addon_weekly'
         AND (
           NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NULL
           OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'locale'), '') IS NOT NULL
         )
       )
       OR (
         p_offer_slug <> 'oto2_addon_weekly'
         AND (
           NULLIF(BTRIM(v_order.tracking_metadata ->> 'locale'), '') IS NULL
           OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NOT NULL
         )
       ) THEN
      RAISE EXCEPTION 'existing Solidgate PWA order binding mismatch'
        USING ERRCODE = '23514';
    END IF;

    v_attempt_text := SUBSTRING(
      v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1
    );
    IF v_attempt_text !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'invalid existing Solidgate PWA order id'
        USING ERRCODE = '23514';
    END IF;
    v_attempt := v_attempt_text::INTEGER;
    v_max_attempt := GREATEST(v_max_attempt, v_attempt);

    v_is_retired := (
      v_order.status = 'failed'
      AND v_order.amount_cents = 0
      AND COALESCE(v_order.solidgate_original_amount_cents, v_order.amount_cents) > 0
      AND COALESCE(
        v_order.solidgate_payment_status IN (
          'auth_failed', 'declined', 'void_ok', 'request_rejected'
        ),
        FALSE
      )
    ) OR v_order.status IN ('canceled', 'expired', 'refunded');

    IF NOT v_is_retired THEN
      IF COALESCE(v_order.solidgate_original_amount_cents, v_order.amount_cents)
            IS DISTINCT FROM p_amount_cents
         OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
         OR (
           p_offer_slug = 'oto2_addon_weekly'
           AND v_order.tracking_metadata ->> 'price_id' IS DISTINCT FROM v_price_binding
         )
         OR (
           p_offer_slug <> 'oto2_addon_weekly'
           AND v_order.tracking_metadata ->> 'locale' IS DISTINCT FROM v_price_binding
         ) THEN
        RAISE EXCEPTION 'current Solidgate PWA order binding mismatch'
          USING ERRCODE = '23514';
      END IF;
      v_open_count := v_open_count + 1;
      v_selected := v_order;
    END IF;
  END LOOP;

  IF v_open_count > 1 THEN
    RAISE EXCEPTION 'multiple payable or uncertain Solidgate PWA orders already exist'
      USING ERRCODE = '23505';
  END IF;

  -- The rolling route could mark an ambiguous provider exception as local
  -- `failed` while retaining the full gross and no durable provider result
  -- (`NULL` on pre-migration rows, `creating` during a rolling deploy). That is not a
  -- terminal decline. Adopt it under a fresh reconcile fence and prove provider
  -- absence before the same id can ever be submitted again.
  IF v_open_count = 1
     AND p_requested_mode = 'saved_card'
     AND v_selected.status = 'failed'
     AND v_selected.amount_cents = p_amount_cents
     AND (
       v_selected.solidgate_payment_status IS NULL
       OR v_selected.solidgate_payment_status = 'creating'
     ) THEN
    UPDATE public.orders AS candidate
    SET status = 'pending',
        solidgate_payment_status = 'creating',
        solidgate_submission_token = p_claim_token,
        solidgate_submission_started_at = NOW()
    WHERE candidate.id = v_selected.id
    RETURNING candidate.* INTO v_selected;
    v_adopted_legacy_failed := TRUE;
  END IF;

  IF v_open_count = 0 THEN
    v_attempt := v_max_attempt + 1;
    IF v_attempt < 1 OR v_attempt > 999999999 THEN
      RAISE EXCEPTION 'Solidgate PWA purchase attempt exhausted'
        USING ERRCODE = '22003';
    END IF;

    INSERT INTO public.orders (
      psp,
      payment_environment,
      solidgate_order_id,
      session_id,
      user_id,
      status,
      amount_cents,
      currency,
      product_name,
      product_slug,
      solidgate_original_amount_cents,
      solidgate_payment_status,
      solidgate_submission_token,
      solidgate_submission_started_at,
      tracking_metadata
    ) VALUES (
      'solidgate',
      p_payment_environment,
      v_expected_prefix || v_attempt::TEXT,
      NULL,
      p_user_id,
      'pending',
      p_amount_cents,
      p_currency,
      p_product_slug,
      p_product_slug,
      p_amount_cents,
      'creating',
      p_claim_token,
      NOW(),
      p_tracking_metadata
    )
    RETURNING * INTO v_selected;
    v_is_new := TRUE;
  END IF;

  INSERT INTO public.solidgate_pwa_purchase_states (
    payment_environment,
    user_id,
    product_slug,
    offer_slug,
    order_db_id,
    purchase_mode,
    claim_token,
    claim_kind,
    claim_started_at
  ) VALUES (
    p_payment_environment,
    p_user_id,
    p_product_slug,
    p_offer_slug,
    v_selected.id,
    p_requested_mode,
    COALESCE(v_selected.solidgate_submission_token, p_claim_token),
    CASE
      WHEN p_requested_mode = 'hosted_form' THEN 'build_form'
      WHEN v_is_new THEN 'submit_card'
      ELSE 'reconcile'
    END,
    COALESCE(v_selected.solidgate_submission_started_at, v_selected.created_at, NOW())
  )
  ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING;
  GET DIAGNOSTICS v_attempt = ROW_COUNT;
  v_state_inserted := v_attempt = 1;

  SELECT state.*
  INTO STRICT v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_state.order_db_id IS DISTINCT FROM v_selected.id THEN
    UPDATE public.solidgate_pwa_purchase_states AS state
    SET offer_slug = p_offer_slug,
        order_db_id = v_selected.id,
        purchase_mode = p_requested_mode,
        claim_token = COALESCE(v_selected.solidgate_submission_token, p_claim_token),
        claim_kind = CASE
          WHEN p_requested_mode = 'hosted_form' THEN 'build_form'
          WHEN v_is_new THEN 'submit_card'
          ELSE 'reconcile'
        END,
        claim_started_at = COALESCE(
          v_selected.solidgate_submission_started_at,
          v_selected.created_at,
          NOW()
        ),
        merchant_data = NULL,
        last_result_kind = NULL,
        last_result_net_amount_cents = NULL,
        last_result_subscription_id = NULL,
        last_result_verify_url = NULL,
        updated_at = NOW()
    WHERE state.payment_environment = p_payment_environment
      AND state.user_id = p_user_id
      AND state.product_slug = p_product_slug
    RETURNING state.* INTO v_state;
    v_state_advanced := TRUE;
  ELSIF v_state.offer_slug IS DISTINCT FROM p_offer_slug
        OR v_state.purchase_mode IS DISTINCT FROM p_requested_mode THEN
    RAISE EXCEPTION 'existing Solidgate PWA purchase mode or offer mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- A webhook/confirm result outranks a still-live local lease. Retire only the
  -- lease bookkeeping; the immutable provider/order state remains authoritative.
  IF v_selected.solidgate_payment_status IS NOT NULL
     AND v_selected.solidgate_payment_status <> 'creating'
     AND v_state.claim_kind IS NOT NULL THEN
    UPDATE public.solidgate_pwa_purchase_states AS state
    SET claim_kind = NULL,
        claim_started_at = NULL,
        updated_at = NOW()
    WHERE state.payment_environment = p_payment_environment
      AND state.user_id = p_user_id
      AND state.product_slug = p_product_slug
    RETURNING state.* INTO v_state;
  END IF;

  IF v_is_new THEN
    IF p_requested_mode = 'hosted_form' THEN
      v_should_build := TRUE;
    ELSE
      v_should_submit := TRUE;
    END IF;
    v_return_claim := p_claim_token;
  ELSIF v_adopted_legacy_failed THEN
    UPDATE public.solidgate_pwa_purchase_states AS state
    SET claim_token = p_claim_token,
        claim_kind = 'reconcile',
        claim_started_at = NOW(),
        updated_at = NOW()
    WHERE state.payment_environment = p_payment_environment
      AND state.user_id = p_user_id
      AND state.product_slug = p_product_slug
    RETURNING state.* INTO v_state;
    v_needs_reconcile := TRUE;
    v_return_claim := p_claim_token;
  ELSIF NOT v_state_inserted AND NOT v_state_advanced
        AND v_selected.status = 'pending'
        AND (
          v_selected.solidgate_payment_status IS NULL
          OR v_selected.solidgate_payment_status = 'creating'
        ) THEN
    IF v_state.purchase_mode = 'hosted_form'
       AND v_state.merchant_data IS NULL
       AND v_state.claim_kind = 'build_form'
       AND v_state.claim_started_at < NOW() - INTERVAL '30 seconds' THEN
      UPDATE public.solidgate_pwa_purchase_states AS state
      SET claim_token = p_claim_token,
          claim_kind = 'build_form',
          claim_started_at = NOW(),
          updated_at = NOW()
      WHERE state.payment_environment = p_payment_environment
        AND state.user_id = p_user_id
        AND state.product_slug = p_product_slug
      RETURNING state.* INTO v_state;

      UPDATE public.orders AS candidate
      SET solidgate_submission_token = p_claim_token,
          solidgate_submission_started_at = NOW()
      WHERE candidate.id = v_selected.id;
      v_should_build := TRUE;
      v_return_claim := p_claim_token;
    ELSIF v_state.purchase_mode = 'hosted_form'
          AND v_state.merchant_data IS NULL
          AND v_state.claim_kind IS NULL THEN
      UPDATE public.solidgate_pwa_purchase_states AS state
      SET claim_token = p_claim_token,
          claim_kind = 'build_form',
          claim_started_at = NOW(),
          updated_at = NOW()
      WHERE state.payment_environment = p_payment_environment
        AND state.user_id = p_user_id
        AND state.product_slug = p_product_slug
      RETURNING state.* INTO v_state;

      UPDATE public.orders AS candidate
      SET solidgate_submission_token = p_claim_token,
          solidgate_submission_started_at = NOW()
      WHERE candidate.id = v_selected.id;
      v_should_build := TRUE;
      v_return_claim := p_claim_token;
    ELSIF v_state.purchase_mode = 'saved_card'
          AND (
            v_state.claim_kind IS NULL
            OR v_state.claim_started_at < NOW() - INTERVAL '120 seconds'
          ) THEN
      UPDATE public.solidgate_pwa_purchase_states AS state
      SET claim_token = p_claim_token,
          claim_kind = 'reconcile',
          claim_started_at = NOW(),
          updated_at = NOW()
      WHERE state.payment_environment = p_payment_environment
        AND state.user_id = p_user_id
        AND state.product_slug = p_product_slug
      RETURNING state.* INTO v_state;

      UPDATE public.orders AS candidate
      SET solidgate_submission_token = p_claim_token,
          solidgate_submission_started_at = NOW()
      WHERE candidate.id = v_selected.id;
      v_needs_reconcile := TRUE;
      v_return_claim := p_claim_token;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_selected.id,
    v_selected.solidgate_order_id,
    v_selected.payment_environment,
    v_selected.user_id,
    v_state.offer_slug,
    v_selected.product_slug,
    v_selected.product_name,
    COALESCE(v_selected.solidgate_original_amount_cents, v_selected.amount_cents),
    LOWER(v_selected.currency),
    v_selected.status,
    v_selected.solidgate_payment_status,
    v_selected.tracking_metadata,
    v_state.purchase_mode,
    v_selected.solidgate_subscription_id,
    v_selected.solidgate_verify_url,
    v_state.last_result_kind,
    v_state.last_result_net_amount_cents,
    v_is_new,
    v_should_build,
    v_should_submit,
    v_needs_reconcile,
    v_return_claim,
    v_state.merchant_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_solidgate_pwa_purchase_v2(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_tracking_metadata JSONB,
  p_requested_mode TEXT,
  p_claim_token UUID,
  p_customer_email TEXT,
  p_checkout_locale TEXT,
  p_solidgate_product_id TEXT,
  p_solidgate_payment_action TEXT
)
RETURNS TABLE (
  order_db_id UUID,
  solidgate_order_id TEXT,
  bound_payment_environment TEXT,
  bound_user_id UUID,
  bound_offer_slug TEXT,
  bound_product_slug TEXT,
  bound_product_name TEXT,
  bound_amount_cents INTEGER,
  bound_currency TEXT,
  bound_order_status TEXT,
  bound_payment_status TEXT,
  bound_tracking_metadata JSONB,
  purchase_mode TEXT,
  solidgate_subscription_id TEXT,
  verify_url TEXT,
  last_result_kind TEXT,
  last_result_net_amount_cents INTEGER,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  bound_solidgate_product_id TEXT,
  bound_solidgate_payment_action TEXT,
  is_new BOOLEAN,
  should_build BOOLEAN,
  should_submit BOOLEAN,
  needs_reconcile BOOLEAN,
  claim_token UUID,
  merchant_data JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_opened RECORD;
  v_identity public.orders%ROWTYPE;
  v_existing_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_state_found BOOLEAN := FALSE;
  v_is_retired BOOLEAN := FALSE;
  v_should_build BOOLEAN := FALSE;
  v_should_submit BOOLEAN := FALSE;
  v_needs_reconcile BOOLEAN := FALSE;
  v_return_claim UUID;
  v_email TEXT := LOWER(BTRIM(COALESCE(p_customer_email, '')));
  v_locale TEXT := BTRIM(COALESCE(p_checkout_locale, ''));
  v_product_id TEXT := NULLIF(BTRIM(COALESCE(p_solidgate_product_id, '')), '');
  v_payment_action TEXT := BTRIM(COALESCE(p_solidgate_payment_action, ''));
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR CHAR_LENGTH(v_email) > 320
     OR v_locale NOT IN (
       'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
       'he', 'pl', 'hr', 'da', 'ja'
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate PWA checkout identity'
      USING ERRCODE = '22023';
  END IF;
  IF (
       NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NOT NULL
       AND v_product_id IS NULL
     ) OR (
       NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NULL
       AND v_product_id IS NOT NULL
     ) OR (
       v_product_id IS NOT NULL
       AND (
         CHAR_LENGTH(v_product_id) > 255
         OR v_product_id !~ '^[[:alnum:]_-]+$'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate PWA provider product identity'
      USING ERRCODE = '22023';
  END IF;
  IF v_payment_action IS DISTINCT FROM 'auth_settle' THEN
    RAISE EXCEPTION 'invalid Solidgate PWA payment action'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.solidgate_customer_email', v_email, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_checkout_locale', v_locale, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_product_id', COALESCE(v_product_id, ''), TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_payment_action', v_payment_action, TRUE);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );
  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;
  v_state_found := FOUND;

  IF v_state_found THEN
    SELECT candidate.*
    INTO STRICT v_existing_order
    FROM public.orders AS candidate
    WHERE candidate.id = v_state.order_db_id
    FOR UPDATE;
    v_is_retired := v_existing_order.status IN ('canceled', 'expired', 'refunded')
      OR (
        v_existing_order.status = 'failed'
        AND v_existing_order.amount_cents = 0
        AND COALESCE(
              v_existing_order.solidgate_original_amount_cents,
              v_existing_order.amount_cents
            ) > 0
        AND v_existing_order.solidgate_payment_status IN (
          'auth_failed', 'declined', 'void_ok', 'request_rejected'
        )
      );
  END IF;

  IF v_state_found AND NOT v_is_retired THEN
    IF v_state.offer_slug IS DISTINCT FROM p_offer_slug
       OR v_state.purchase_mode IS DISTINCT FROM p_requested_mode
       OR v_existing_order.payment_environment IS DISTINCT FROM p_payment_environment
       OR v_existing_order.user_id IS DISTINCT FROM p_user_id
       OR v_existing_order.session_id IS NOT NULL
       OR v_existing_order.psp IS DISTINCT FROM 'solidgate'
       OR v_existing_order.product_slug IS DISTINCT FROM p_product_slug
       OR v_existing_order.product_name IS DISTINCT FROM p_product_slug
       OR COALESCE(
            v_existing_order.solidgate_original_amount_cents,
            v_existing_order.amount_cents
          ) IS DISTINCT FROM p_amount_cents
       OR LOWER(v_existing_order.currency) IS DISTINCT FROM p_currency
       OR v_existing_order.tracking_metadata IS DISTINCT FROM p_tracking_metadata
       OR v_existing_order.solidgate_customer_email IS DISTINCT FROM v_email
       OR v_existing_order.solidgate_checkout_locale IS DISTINCT FROM v_locale
       OR v_existing_order.solidgate_product_id IS DISTINCT FROM v_product_id
       OR v_existing_order.solidgate_payment_action IS DISTINCT FROM v_payment_action
       OR v_existing_order.solidgate_checkout_identity_legacy THEN
      RAISE EXCEPTION 'existing Solidgate PWA purchase snapshot mismatch'
        USING ERRCODE = '23514';
    END IF;

    IF p_requested_mode = 'saved_card'
       AND v_existing_order.status = 'failed'
       AND v_existing_order.amount_cents = p_amount_cents
       AND (
         v_existing_order.solidgate_payment_status IS NULL
         OR v_existing_order.solidgate_payment_status = 'creating'
       ) THEN
      UPDATE public.orders AS candidate
      SET status = 'pending',
          solidgate_payment_status = 'creating',
          solidgate_submission_token = p_claim_token,
          solidgate_submission_started_at = NOW()
      WHERE candidate.id = v_existing_order.id
      RETURNING candidate.* INTO v_existing_order;
      UPDATE public.solidgate_pwa_purchase_states AS state
      SET claim_token = p_claim_token,
          claim_kind = 'reconcile',
          claim_started_at = NOW(),
          updated_at = NOW()
      WHERE state.payment_environment = p_payment_environment
        AND state.user_id = p_user_id
        AND state.product_slug = p_product_slug
      RETURNING state.* INTO v_state;
      v_needs_reconcile := TRUE;
      v_return_claim := p_claim_token;
    ELSE
      IF v_existing_order.solidgate_payment_status IS NOT NULL
         AND v_existing_order.solidgate_payment_status <> 'creating'
         AND v_state.claim_kind IS NOT NULL THEN
        UPDATE public.solidgate_pwa_purchase_states AS state
        SET claim_kind = NULL,
            claim_started_at = NULL,
            updated_at = NOW()
        WHERE state.payment_environment = p_payment_environment
          AND state.user_id = p_user_id
          AND state.product_slug = p_product_slug
        RETURNING state.* INTO v_state;
      END IF;

      IF v_existing_order.status = 'pending'
         AND (
           v_existing_order.solidgate_payment_status IS NULL
           OR v_existing_order.solidgate_payment_status = 'creating'
         ) THEN
        IF p_requested_mode = 'hosted_form'
           AND v_state.merchant_data IS NULL
           AND (
             (v_state.claim_kind = 'build_form' AND v_state.claim_token = p_claim_token)
             OR v_state.claim_kind IS NULL
             OR v_state.claim_started_at < NOW() - INTERVAL '30 seconds'
           ) THEN
          UPDATE public.solidgate_pwa_purchase_states AS state
          SET claim_token = p_claim_token,
              claim_kind = 'build_form',
              claim_started_at = NOW(),
              updated_at = NOW()
          WHERE state.payment_environment = p_payment_environment
            AND state.user_id = p_user_id
            AND state.product_slug = p_product_slug
          RETURNING state.* INTO v_state;
          UPDATE public.orders AS candidate
          SET solidgate_submission_token = p_claim_token,
              solidgate_submission_started_at = NOW()
          WHERE candidate.id = v_existing_order.id;
          v_should_build := TRUE;
          v_return_claim := p_claim_token;
        ELSIF p_requested_mode = 'saved_card'
              AND (
                v_state.claim_kind IS NULL
                OR v_state.claim_started_at < NOW() - INTERVAL '120 seconds'
              ) THEN
          UPDATE public.solidgate_pwa_purchase_states AS state
          SET claim_token = p_claim_token,
              claim_kind = 'reconcile',
              claim_started_at = NOW(),
              updated_at = NOW()
          WHERE state.payment_environment = p_payment_environment
            AND state.user_id = p_user_id
            AND state.product_slug = p_product_slug
          RETURNING state.* INTO v_state;
          UPDATE public.orders AS candidate
          SET solidgate_submission_token = p_claim_token,
              solidgate_submission_started_at = NOW()
          WHERE candidate.id = v_existing_order.id;
          v_needs_reconcile := TRUE;
          v_return_claim := p_claim_token;
        END IF;
      END IF;
    END IF;

    SELECT
      v_existing_order.id AS order_db_id,
      v_existing_order.solidgate_order_id AS solidgate_order_id,
      v_existing_order.payment_environment AS bound_payment_environment,
      v_existing_order.user_id AS bound_user_id,
      v_state.offer_slug AS bound_offer_slug,
      v_existing_order.product_slug AS bound_product_slug,
      v_existing_order.product_name AS bound_product_name,
      COALESCE(
        v_existing_order.solidgate_original_amount_cents,
        v_existing_order.amount_cents
      ) AS bound_amount_cents,
      LOWER(v_existing_order.currency) AS bound_currency,
      v_existing_order.status AS bound_order_status,
      v_existing_order.solidgate_payment_status AS bound_payment_status,
      v_existing_order.tracking_metadata AS bound_tracking_metadata,
      v_state.purchase_mode AS purchase_mode,
      v_existing_order.solidgate_subscription_id AS solidgate_subscription_id,
      v_existing_order.solidgate_verify_url AS verify_url,
      v_state.last_result_kind AS last_result_kind,
      v_state.last_result_net_amount_cents AS last_result_net_amount_cents,
      FALSE AS is_new,
      v_should_build AS should_build,
      v_should_submit AS should_submit,
      v_needs_reconcile AS needs_reconcile,
      v_return_claim AS claim_token,
      v_state.merchant_data AS merchant_data
    INTO STRICT v_opened;
  ELSE
    SELECT opened.*
    INTO STRICT v_opened
    FROM public.open_solidgate_pwa_purchase(
      p_payment_environment,
      p_user_id,
      p_offer_slug,
      p_product_slug,
      p_amount_cents,
      p_currency,
      p_tracking_metadata,
      p_requested_mode,
      p_claim_token
    ) AS opened;
  END IF;

  SELECT candidate.*
  INTO STRICT v_identity
  FROM public.orders AS candidate
  WHERE candidate.id = v_opened.order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.solidgate_order_id = v_opened.solidgate_order_id
    AND candidate.user_id = p_user_id
    AND candidate.session_id IS NULL
    AND candidate.psp = 'solidgate'
  FOR SHARE;

  IF v_identity.solidgate_checkout_identity_legacy
     OR v_identity.solidgate_customer_email IS NULL
     OR v_identity.solidgate_checkout_locale IS NULL
     OR v_identity.solidgate_checkout_identity_bound_at IS NULL THEN
    RAISE EXCEPTION 'legacy Solidgate PWA checkout identity requires provider reconciliation'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config('app.solidgate_customer_email', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_checkout_locale', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_product_id', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_payment_action', '', TRUE);

  RETURN QUERY SELECT
    v_opened.order_db_id::UUID,
    v_opened.solidgate_order_id::TEXT,
    v_opened.bound_payment_environment::TEXT,
    v_opened.bound_user_id::UUID,
    v_opened.bound_offer_slug::TEXT,
    v_opened.bound_product_slug::TEXT,
    v_opened.bound_product_name::TEXT,
    v_opened.bound_amount_cents::INTEGER,
    v_opened.bound_currency::TEXT,
    v_opened.bound_order_status::TEXT,
    v_opened.bound_payment_status::TEXT,
    v_opened.bound_tracking_metadata::JSONB,
    v_opened.purchase_mode::TEXT,
    v_opened.solidgate_subscription_id::TEXT,
    v_opened.verify_url::TEXT,
    v_opened.last_result_kind::TEXT,
    v_opened.last_result_net_amount_cents::INTEGER,
    v_identity.solidgate_customer_email,
    v_identity.solidgate_checkout_locale,
    v_identity.solidgate_product_id,
    v_identity.solidgate_payment_action,
    v_opened.is_new::BOOLEAN,
    v_opened.should_build::BOOLEAN,
    v_opened.should_submit::BOOLEAN,
    v_opened.needs_reconcile::BOOLEAN,
    v_opened.claim_token::UUID,
    v_opened.merchant_data::JSONB;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_pwa_form(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID,
  p_merchant_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_claim_token IS NULL
     OR p_merchant_data IS NULL
     OR jsonb_typeof(p_merchant_data) <> 'object'
     OR jsonb_typeof(p_merchant_data -> 'merchant') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'paymentIntent') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'signature') <> 'string'
     OR NULLIF(BTRIM(p_merchant_data ->> 'merchant'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'paymentIntent'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'signature'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA form finalization'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  SELECT state.*
  INTO STRICT v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR SUBSTRING(v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1)
          !~ '^[1-9][0-9]{0,8}$'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.purchase_mode IS DISTINCT FROM 'hosted_form' THEN
    RAISE EXCEPTION 'Solidgate PWA form binding changed before finalization'
      USING ERRCODE = '23514';
  END IF;

  IF v_state.merchant_data IS NOT NULL THEN
    IF v_state.claim_token IS DISTINCT FROM p_claim_token
       OR v_state.merchant_data IS DISTINCT FROM p_merchant_data THEN
      RAISE EXCEPTION 'Solidgate PWA form builder lost ownership'
        USING ERRCODE = '40001';
    END IF;
    IF v_order.status IS DISTINCT FROM 'pending'
       OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating' THEN
      RAISE EXCEPTION 'Solidgate PWA form order changed after finalization'
        USING ERRCODE = '40001';
    END IF;
    RETURN v_state.merchant_data;
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending'
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating'
     OR v_order.solidgate_submission_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_kind IS DISTINCT FROM 'build_form' THEN
    RAISE EXCEPTION 'Solidgate PWA form builder lost ownership'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET merchant_data = p_merchant_data,
      claim_kind = NULL,
      claim_started_at = NULL,
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.purchase_mode = 'hosted_form'
    AND state.claim_token = p_claim_token
    AND state.claim_kind = 'build_form'
  RETURNING state.* INTO v_state;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solidgate PWA form builder lost ownership'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.orders AS candidate
  SET solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE candidate.id = p_order_db_id
    AND candidate.status = 'pending'
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_claim_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solidgate PWA form order changed during finalization'
      USING ERRCODE = '40001';
  END IF;

  RETURN v_state.merchant_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_pwa_form_v2(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID,
  p_merchant_data JSONB,
  p_customer_email TEXT,
  p_checkout_locale TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_identity public.orders%ROWTYPE;
BEGIN
  SELECT candidate.*
  INTO STRICT v_identity
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.user_id = p_user_id
    AND candidate.session_id IS NULL
    AND candidate.psp = 'solidgate'
  FOR SHARE;

  IF v_identity.solidgate_checkout_identity_legacy
     OR v_identity.solidgate_customer_email
          IS DISTINCT FROM LOWER(BTRIM(COALESCE(p_customer_email, '')))
     OR v_identity.solidgate_checkout_locale
          IS DISTINCT FROM BTRIM(COALESCE(p_checkout_locale, '')) THEN
    RAISE EXCEPTION 'Solidgate PWA checkout identity changed before finalization'
      USING ERRCODE = '23514';
  END IF;

  RETURN public.finalize_solidgate_pwa_form(
    p_payment_environment,
    p_user_id,
    p_offer_slug,
    p_product_slug,
    p_order_db_id,
    p_solidgate_order_id,
    p_amount_cents,
    p_currency,
    p_claim_token,
    p_merchant_data
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_solidgate_pwa_submission_result(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID,
  p_result_kind TEXT,
  p_provider_status TEXT,
  p_net_amount_cents INTEGER,
  p_subscription_id TEXT,
  p_verify_url TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_claim_token IS NULL
     OR p_result_kind IS NULL
     OR p_result_kind NOT IN (
       'pending', 'requires_action', 'captured', 'terminal_failure'
     )
     OR NULLIF(BTRIM(p_provider_status), '') IS NULL
     OR p_net_amount_cents IS NULL
     OR p_net_amount_cents < 0 THEN
    RAISE EXCEPTION 'invalid Solidgate PWA submission result'
      USING ERRCODE = '22023';
  END IF;

  IF p_result_kind = 'terminal_failure' THEN
    -- `request_rejected` is admitted only from the route's claim-fenced,
    -- definite no-provider-order branch. The zero-net/subscription/verify-url
    -- checks below remain the database-side retirement fence.
    IF p_provider_status NOT IN (
         'auth_failed', 'declined', 'void_ok', 'request_rejected'
       )
       OR p_net_amount_cents <> 0
       OR p_subscription_id IS NOT NULL
       OR p_verify_url IS NOT NULL THEN
      RAISE EXCEPTION 'invalid terminal Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_result_kind = 'captured' THEN
    IF p_provider_status NOT IN ('settle_ok', 'partial_settled')
       OR p_net_amount_cents <> p_amount_cents
       OR p_verify_url IS NOT NULL
       OR (
         p_offer_slug = 'oto2_addon_weekly'
         AND NULLIF(BTRIM(p_subscription_id), '') IS NULL
       )
       OR (
         p_offer_slug <> 'oto2_addon_weekly'
         AND p_subscription_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'invalid captured Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_result_kind = 'requires_action' THEN
    -- /recurring may return a top-level verify_url while the nested order is
    -- still created/processing/auth_ok. 3ds_verify is not guaranteed until the
    -- buyer actually opens or completes the challenge.
    IF p_provider_status NOT IN ('created', 'processing', 'auth_ok', '3ds_verify')
       OR p_net_amount_cents <> p_amount_cents
       OR p_verify_url IS NULL
       OR p_verify_url !~ '^https://[^[:space:]]+$'
       OR (p_offer_slug <> 'oto2_addon_weekly' AND p_subscription_id IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid actionable Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- `3ds_verify` with no URL is a valid fail-closed observation when the
    -- provider's canonical and compatibility URL aliases conflict. Persisting
    -- it as pending clears any cached ACS URL without pretending the
    -- challenge is actionable.
    IF p_provider_status NOT IN (
         'created', 'processing', 'auth_ok', 'partial_settled', '3ds_verify'
       )
       OR p_net_amount_cents <> p_amount_cents
       OR p_verify_url IS NOT NULL
       OR (p_offer_slug <> 'oto2_addon_weekly' AND p_subscription_id IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid pending Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_order.id IS NULL OR v_state.order_db_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR SUBSTRING(v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1)
          !~ '^[1-9][0-9]{0,8}$'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.purchase_mode IS DISTINCT FROM 'saved_card' THEN
    RAISE EXCEPTION 'Solidgate PWA submission result binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- The same owner may retry after losing the RPC response, but only while the
  -- order still exactly reflects that owner's already-recorded result. Any
  -- webhook, confirm, or lease-takeover change returns false.
  IF v_state.claim_kind IS NULL
     AND v_state.claim_token = p_claim_token
     AND v_state.last_result_kind = p_result_kind
     AND v_state.last_result_net_amount_cents = p_net_amount_cents
     AND v_state.last_result_subscription_id IS NOT DISTINCT FROM p_subscription_id
     AND v_state.last_result_verify_url IS NOT DISTINCT FROM p_verify_url THEN
    IF p_result_kind = 'terminal_failure' THEN
      RETURN v_order.status = 'failed'
        AND v_order.amount_cents = 0
        AND v_order.solidgate_original_amount_cents = p_amount_cents
        AND v_order.solidgate_payment_status = p_provider_status;
    END IF;
    RETURN v_order.status = 'pending'
      AND v_order.amount_cents = p_amount_cents
      AND v_order.solidgate_payment_status = p_provider_status
      AND v_order.solidgate_subscription_id IS NOT DISTINCT FROM p_subscription_id
      AND v_order.solidgate_verify_url IS NOT DISTINCT FROM p_verify_url;
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending'
     OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating'
     OR v_order.solidgate_submission_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_kind NOT IN ('submit_card', 'reconcile') THEN
    RETURN FALSE;
  END IF;

  UPDATE public.orders AS candidate
  SET status = CASE
        WHEN p_result_kind = 'terminal_failure' THEN 'failed'
        ELSE 'pending'
      END,
      amount_cents = CASE
        WHEN p_result_kind = 'terminal_failure' THEN 0
        ELSE p_amount_cents
      END,
      solidgate_original_amount_cents = p_amount_cents,
      solidgate_payment_status = p_provider_status,
      solidgate_subscription_id = p_subscription_id,
      solidgate_verify_url = p_verify_url,
      solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE candidate.id = p_order_db_id
    AND candidate.status = 'pending'
    AND candidate.amount_cents = p_amount_cents
    AND candidate.solidgate_original_amount_cents = p_amount_cents
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_claim_token;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET claim_kind = NULL,
      claim_started_at = NULL,
      last_result_kind = p_result_kind,
      last_result_net_amount_cents = p_net_amount_cents,
      last_result_subscription_id = p_subscription_id,
      last_result_verify_url = p_verify_url,
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.purchase_mode = 'saved_card'
    AND state.claim_token = p_claim_token
    AND state.claim_kind IN ('submit_card', 'reconcile');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solidgate PWA result fence changed during publication'
      USING ERRCODE = '40001';
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_solidgate_pwa_submission_after_absent_reconcile(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA reconcile claim'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_order.id IS NULL OR v_state.order_db_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR SUBSTRING(v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1)
          !~ '^[1-9][0-9]{0,8}$'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.purchase_mode IS DISTINCT FROM 'saved_card' THEN
    RAISE EXCEPTION 'Solidgate PWA reconcile binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending'
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating'
     OR v_order.solidgate_submission_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_kind IS DISTINCT FROM 'reconcile'
     OR v_state.claim_started_at < NOW() - INTERVAL '120 seconds' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET claim_kind = 'submit_card',
      claim_started_at = NOW(),
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.claim_token = p_claim_token
    AND state.claim_kind = 'reconcile';

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.orders AS candidate
  SET solidgate_submission_started_at = NOW()
  WHERE candidate.id = p_order_db_id
    AND candidate.status = 'pending'
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_claim_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solidgate PWA reconcile fence changed during resume'
      USING ERRCODE = '40001';
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_solidgate_pwa_confirmed_capture(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_provider_status TEXT,
  p_subscription_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_current_order public.orders%ROWTYPE;
  v_expected_product TEXT;
  v_is_subscription BOOLEAN;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_is_subscription := p_offer_slug = 'oto2_addon_weekly';
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_solidgate_order_id, '')), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR LOWER(BTRIM(COALESCE(p_currency, ''))) !~ '^[a-z]{3}$'
     OR p_provider_status NOT IN ('settle_ok', 'partial_settled')
     OR (v_is_subscription AND NULLIF(BTRIM(COALESCE(p_subscription_id, '')), '') IS NULL)
     OR (NOT v_is_subscription AND p_subscription_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid confirmed Solidgate PWA capture'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR SHARE;
  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN 'invalid'; END IF;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM LOWER(p_currency)
     OR v_order.solidgate_payment_status IS DISTINCT FROM p_provider_status
     OR v_order.solidgate_subscription_id IS DISTINCT FROM p_subscription_id
     OR v_order.solidgate_refunded_amount_cents IS DISTINCT FROM 0
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0
     OR v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
     OR NOT public.solidgate_checkout_core_is_canonical(v_order)
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_order.tracking_metadata ->> 'price_id'
          IS DISTINCT FROM v_order.solidgate_product_id
     OR (v_is_subscription AND v_order.status IS DISTINCT FROM 'active')
     OR (NOT v_is_subscription AND v_order.status IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'confirmed Solidgate PWA capture binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF v_state.order_db_id IS NULL THEN RETURN 'invalid'; END IF;
  IF v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.purchase_mode NOT IN ('hosted_form', 'saved_card') THEN
    RAISE EXCEPTION 'confirmed Solidgate PWA state binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF v_state.order_db_id IS DISTINCT FROM p_order_db_id THEN
    SELECT candidate.*
    INTO v_current_order
    FROM public.orders AS candidate
    WHERE candidate.id = v_state.order_db_id
    FOR SHARE;
    IF v_current_order.id IS NULL
       OR v_current_order.payment_environment IS DISTINCT FROM p_payment_environment
       OR v_current_order.user_id IS DISTINCT FROM p_user_id
       OR v_current_order.session_id IS NOT NULL
       OR v_current_order.psp IS DISTINCT FROM 'solidgate'
       OR v_current_order.product_slug IS DISTINCT FROM p_product_slug
       OR v_current_order.product_name IS DISTINCT FROM p_product_slug
       OR v_current_order.solidgate_checkout_identity_legacy
       OR v_current_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
       OR NOT public.solidgate_checkout_core_is_canonical(v_current_order)
       OR v_current_order.tracking_metadata ->> 'product_slug'
            IS DISTINCT FROM p_offer_slug
       OR v_current_order.tracking_metadata ->> 'price_id'
            IS DISTINCT FROM v_current_order.solidgate_product_id
       OR (v_current_order.created_at, v_current_order.id)
            <= (v_order.created_at, v_order.id) THEN
      RAISE EXCEPTION 'confirmed Solidgate PWA current state is not newer'
        USING ERRCODE = '23514';
    END IF;
    RETURN 'stale';
  END IF;

  IF v_state.purchase_mode = 'saved_card' THEN
    IF v_state.last_result_kind = 'captured' THEN
      IF v_state.last_result_net_amount_cents IS DISTINCT FROM p_amount_cents
         OR v_state.last_result_subscription_id IS DISTINCT FROM p_subscription_id
         OR v_state.last_result_verify_url IS NOT NULL THEN
        RETURN 'invalid';
      END IF;
      RETURN 'saved_card';
    END IF;
    IF v_state.last_result_kind IS NOT NULL
       AND v_state.last_result_kind NOT IN (
         'pending', 'requires_action', 'terminal_failure'
       ) THEN
      RETURN 'invalid';
    END IF;
    UPDATE public.solidgate_pwa_purchase_states AS state
    SET claim_kind = NULL,
        claim_started_at = NULL,
        last_result_kind = 'captured',
        last_result_net_amount_cents = p_amount_cents,
        last_result_subscription_id = p_subscription_id,
        last_result_verify_url = NULL,
        updated_at = NOW()
    WHERE state.payment_environment = p_payment_environment
      AND state.user_id = p_user_id
      AND state.product_slug = p_product_slug
      AND state.order_db_id = p_order_db_id
      AND state.purchase_mode = 'saved_card'
      AND (
        state.last_result_kind IS NULL
        OR state.last_result_kind IN (
          'pending', 'requires_action', 'terminal_failure'
        )
      );
    IF NOT FOUND THEN RETURN 'invalid'; END IF;
    RETURN 'saved_card';
  END IF;

  IF v_state.merchant_data IS NULL
     OR pg_catalog.jsonb_typeof(v_state.merchant_data) IS DISTINCT FROM 'object' THEN
    RETURN 'invalid';
  END IF;
  IF v_state.last_result_kind IS NOT NULL THEN
    IF v_state.last_result_kind IS DISTINCT FROM 'captured'
       OR v_state.last_result_net_amount_cents IS DISTINCT FROM p_amount_cents
       OR v_state.last_result_subscription_id IS DISTINCT FROM p_subscription_id
       OR v_state.last_result_verify_url IS NOT NULL THEN
      RETURN 'invalid';
    END IF;
    RETURN 'hosted_form';
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET last_result_kind = 'captured',
      last_result_net_amount_cents = p_amount_cents,
      last_result_subscription_id = p_subscription_id,
      last_result_verify_url = NULL,
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.purchase_mode = 'hosted_form'
    AND state.last_result_kind IS NULL;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  RETURN 'hosted_form';
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_solidgate_oto_progress(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_current_step INTEGER,
  p_allow_catch_up BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  persisted_step INTEGER,
  advanced BOOLEAN,
  conflict BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_raw_step TEXT;
  v_persisted_step INTEGER;
  v_target_step INTEGER;
  v_oto_environment TEXT;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_payment_environment';
  END IF;

  v_target_step := CASE p_current_step
    WHEN 1 THEN 2
    WHEN 2 THEN 3
    WHEN 3 THEN 4
    WHEN 4 THEN 5
    WHEN 5 THEN 6
    WHEN 6 THEN 7
    WHEN 7 THEN 8
    ELSE NULL
  END;

  IF v_target_step IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_oto_current_step';
  END IF;

  SELECT sessions.last_oto_step, sessions.solidgate_oto_environment
  INTO v_raw_step, v_oto_environment
  FROM public.sessions
  WHERE sessions.id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'oto_progress_session_not_found';
  END IF;

  IF v_oto_environment IS NULL THEN
    UPDATE public.sessions
    SET solidgate_oto_environment = p_payment_environment,
        updated_at = NOW()
    WHERE sessions.id = p_session_id;
  ELSIF v_oto_environment IS DISTINCT FROM p_payment_environment THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'oto_progress_environment_mismatch';
  END IF;

  -- A paid checkout enters the chain on OTO1 without writing a checkpoint, so
  -- NULL and the explicit legacy value "1" both mean "currently on OTO1".
  IF v_raw_step IS NULL THEN
    v_persisted_step := 1;
  ELSE
    v_persisted_step := CASE v_raw_step
      WHEN '1' THEN 1
      WHEN '2' THEN 2
      WHEN '3' THEN 3
      WHEN '4' THEN 4
      WHEN '5' THEN 5
      WHEN '6' THEN 6
      WHEN '7' THEN 7
      WHEN '8' THEN 8
      ELSE NULL
    END;
  END IF;

  IF v_persisted_step IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid_persisted_oto_step';
  END IF;

  -- A delayed/duplicate request is idempotent and can never move the session
  -- backwards. Return the winning durable checkpoint to the caller.
  IF v_persisted_step >= v_target_step THEN
    RETURN QUERY SELECT v_persisted_step, FALSE, FALSE;
    RETURN;
  END IF;

  -- An ordinary skip must match the durable current page. Only a
  -- provider-accepted purchase, invoked by the trusted charge route, may
  -- repair a missed checkpoint and catch up to the offer's canonical successor.
  IF v_persisted_step < p_current_step AND NOT COALESCE(p_allow_catch_up, FALSE) THEN
    RETURN QUERY SELECT v_persisted_step, FALSE, TRUE;
    RETURN;
  END IF;

  -- A skip and an order open both serialize on the session row. If the order
  -- opener won, a browser may not skip past a charge that is payable, settled,
  -- or still ambiguous. If the skip won, the opener observes the advanced
  -- checkpoint and refuses to mint an order. Captured-purchase advancement is
  -- the trusted exception and remains idempotent.
  IF NOT COALESCE(p_allow_catch_up, FALSE) AND EXISTS (
    SELECT 1
    FROM public.orders AS candidate
    WHERE candidate.session_id = p_session_id
      AND candidate.psp = 'solidgate'
      AND candidate.payment_environment = p_payment_environment
      AND public.solidgate_oto_step_from_product_slug(candidate.product_slug)
            = p_current_step
      AND (
        candidate.status IS DISTINCT FROM 'failed'
        OR candidate.amount_cents IS DISTINCT FROM 0
        OR candidate.solidgate_payment_status IS NULL
        OR candidate.solidgate_payment_status
             NOT IN ('auth_failed', 'declined', 'void_ok', 'request_rejected')
      )
  ) THEN
    RETURN QUERY SELECT v_persisted_step, FALSE, TRUE;
    RETURN;
  END IF;

  UPDATE public.sessions
  SET last_oto_step = v_target_step::TEXT,
      updated_at = NOW()
  WHERE id = p_session_id;

  RETURN QUERY SELECT v_target_step, TRUE, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_solidgate_legacy_order_identity(
  p_payment_environment TEXT,
  p_solidgate_order_id TEXT,
  p_customer_email TEXT,
  p_customer_account_id TEXT,
  p_order_description TEXT,
  p_solidgate_product_id TEXT,
  p_original_amount_cents INTEGER,
  p_currency TEXT,
  p_order_metadata JSONB,
  p_card_token TEXT,
  p_card_brand TEXT,
  p_card_last4 TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_expected_account_id TEXT;
  v_prefix TEXT;
  v_checkout_locale TEXT;
  v_expected_description TEXT;
  v_product_id TEXT;
  v_requires_product_id BOOLEAN;
  v_payment_action TEXT;
  v_card_token TEXT := NULLIF(BTRIM(COALESCE(p_card_token, '')), '');
  v_card_last4 TEXT := NULLIF(BTRIM(COALESCE(p_card_last4, '')), '');
BEGIN
  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.psp = 'solidgate'
    AND candidate.payment_environment = p_payment_environment
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.solidgate_checkout_identity_legacy
  FOR UPDATE;

  -- PWA uses `u-<uuid>` only for order_id/metadata.session_id. The provider
  -- customer_account_id remains the raw authenticated UUID (see purchase route).
  v_expected_account_id := COALESCE(v_order.session_id::TEXT, v_order.user_id::TEXT);
  v_prefix := pg_catalog.split_part(BTRIM(COALESCE(p_order_description, '')), '_', 1);
  v_checkout_locale := CASE v_prefix
    WHEN 'EN' THEN 'en' WHEN 'CZ' THEN 'cs' WHEN 'HU' THEN 'hu'
    WHEN 'SK' THEN 'sk' WHEN 'RO' THEN 'ro' WHEN 'LT' THEN 'lt'
    WHEN 'RU' THEN 'ru' WHEN 'LV' THEN 'lv' WHEN 'TW' THEN 'zh-TW'
    WHEN 'GR' THEN 'el' WHEN 'IL' THEN 'he' WHEN 'PL' THEN 'pl'
    WHEN 'HR' THEN 'hr' WHEN 'DK' THEN 'da' WHEN 'JP' THEN 'ja'
    ELSE NULL
  END;
  v_expected_description := v_prefix || '_' || v_order.product_name;
  v_product_id := NULLIF(BTRIM(COALESCE(p_solidgate_product_id, '')), '');
  v_requires_product_id := v_order.product_slug IN (
    'BRAND_000000_SUB', 'BRANDADDON_000000_SUB'
  );
  v_payment_action := CASE
    WHEN v_order.product_slug = 'BRAND_000000_SUB'
         AND p_original_amount_cents = 0 THEN 'auth_0_amount'
    ELSE 'auth_settle'
  END;

  IF v_expected_account_id IS NULL
     OR NOT public.solidgate_checkout_core_is_canonical(v_order)
     OR p_order_metadata IS DISTINCT FROM v_order.tracking_metadata
     OR p_customer_account_id IS DISTINCT FROM v_expected_account_id
     OR LOWER(BTRIM(COALESCE(p_customer_email, '')))
          !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR v_checkout_locale IS NULL
     OR (
       NOT v_requires_product_id
       AND v_order.tracking_metadata ->> 'locale' IS DISTINCT FROM v_checkout_locale
     )
     OR (v_requires_product_id AND v_product_id IS NULL)
     OR (NOT v_requires_product_id AND v_product_id IS NOT NULL)
     OR (
       v_requires_product_id
       AND v_product_id IS DISTINCT FROM NULLIF(
         BTRIM(v_order.tracking_metadata ->> 'price_id'),
         ''
       )
     )
     OR (
       v_product_id IS NOT NULL
       AND (
         CHAR_LENGTH(v_product_id) > 255
         OR v_product_id !~ '^[[:alnum:]_-]+$'
       )
     )
     OR (
       BTRIM(COALESCE(p_order_description, '')) IS DISTINCT FROM v_expected_description
       AND BTRIM(COALESCE(p_order_description, '')) IS DISTINCT FROM (
         v_expected_description || ' o:' || v_prefix || '_BRAND_000000_SUB'
       )
     )
     OR p_original_amount_cents IS NULL
     OR p_original_amount_cents < 0
     OR (
       v_order.solidgate_original_amount_cents IS NOT NULL
       AND p_original_amount_cents IS DISTINCT FROM v_order.solidgate_original_amount_cents
     )
     OR (
       v_order.solidgate_original_amount_cents IS NULL
       AND (
         v_order.amount_cents < 0
         OR v_order.amount_cents > p_original_amount_cents
       )
     )
     OR LOWER(BTRIM(COALESCE(p_currency, '')))
          IS DISTINCT FROM LOWER(v_order.currency) THEN
    RAISE EXCEPTION 'provider evidence does not match legacy Solidgate order'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.solidgate_identity_reconcile_order',
    v_order.id::TEXT,
    TRUE
  );

  UPDATE public.orders AS candidate
  SET solidgate_original_amount_cents = COALESCE(
        candidate.solidgate_original_amount_cents,
        p_original_amount_cents
      ),
      solidgate_customer_email = p_customer_email,
      solidgate_checkout_locale = v_checkout_locale,
      solidgate_product_id = v_product_id,
      solidgate_payment_action = v_payment_action,
      solidgate_checkout_identity_bound_at = NOW(),
      solidgate_checkout_identity_legacy = FALSE
  WHERE candidate.id = v_order.id;

  -- The historical session vault can be source-bound only when the exact
  -- provider transaction exposes the very same reusable token. Processing a
  -- later main order with the same token may advance the source tuple; a late
  -- older order cannot move it backwards.
  IF v_order.product_slug = 'BRAND_000000_SUB'
     AND v_order.session_id IS NOT NULL
     AND v_card_token IS NOT NULL
     AND (v_card_last4 IS NULL OR v_card_last4 ~ '^[0-9]{4}$') THEN
    -- The later monotonic-writer migration installs the same exact-source
    -- trigger on this table. Set its transaction-local fence here as well so
    -- an operator reconciliation cannot bypass (or be broken by) that guard.
    PERFORM pg_catalog.set_config(
      'app.solidgate_session_vault_source_write',
      v_order.id::TEXT,
      TRUE
    );
    UPDATE public.solidgate_session_vault AS vault
    SET customer_account_id = v_order.session_id::TEXT,
        card_brand = NULLIF(BTRIM(COALESCE(p_card_brand, '')), ''),
        card_last4 = v_card_last4,
        card_source_order_id = v_order.id,
        card_source_created_at = v_order.created_at,
        card_source_sequence = v_order.solidgate_card_source_sequence,
        card_source_legacy = FALSE,
        updated_at = NOW()
    WHERE vault.payment_environment = p_payment_environment
      AND vault.session_id = v_order.session_id
      AND vault.card_token = v_card_token
      AND (
        vault.card_source_legacy
        OR (
          vault.card_source_created_at,
          vault.card_source_sequence,
          vault.card_source_order_id
        ) < (
          v_order.created_at,
          v_order.solidgate_card_source_sequence,
          v_order.id
        )
      );
    PERFORM pg_catalog.set_config(
      'app.solidgate_session_vault_source_write',
      '',
      TRUE
    );
  END IF;

  RETURN TRUE;
END;
$$;


-- ── entitlement grants ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.solidgate_special_free_card_ready(
  p_order_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_has_usable_token BOOLEAN := FALSE;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_id
  FOR SHARE;

  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_name IS DISTINCT FROM 'BRAND_000000_SUB'
     OR v_order.product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR v_order.session_id IS NULL
     OR v_order.tracking_metadata IS NULL
     OR pg_catalog.jsonb_typeof(v_order.tracking_metadata) <> 'object'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'special_free'
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM 'special_free'
     OR v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_0_amount'
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'auth_ok'
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM 0
     OR v_order.amount_cents IS DISTINCT FROM 0
     OR v_order.solidgate_refunded_amount_cents IS DISTINCT FROM 0
     OR v_order.status NOT IN ('trialing', 'active', 'past_due')
     OR NULLIF(BTRIM(v_order.solidgate_subscription_id), '') IS NULL
     OR v_order.solidgate_card_source_sequence IS NULL
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN FALSE;
  END IF;

  SELECT TRUE
  INTO v_has_usable_token
  FROM public.orders AS vault_source
  JOIN public.solidgate_session_vault AS vault
    ON vault.card_source_order_id = vault_source.id
   AND vault.payment_environment = vault_source.payment_environment
   AND vault.session_id = vault_source.session_id
   AND vault.card_source_created_at IS NOT DISTINCT FROM vault_source.created_at
   AND vault.card_source_sequence
         IS NOT DISTINCT FROM vault_source.solidgate_card_source_sequence
  WHERE vault.payment_environment = v_order.payment_environment
    AND vault.session_id = v_order.session_id
    AND vault.customer_account_id = v_order.session_id::TEXT
    AND NULLIF(BTRIM(vault.card_token), '') IS NOT NULL
    AND vault.card_original_payment_method IN (
      'card',
      'apple-pay',
      'google-pay',
      'network-token'
    )
    AND NOT vault.card_source_legacy
    AND vault_source.psp = 'solidgate'
    AND vault_source.product_name = 'BRAND_000000_SUB'
    AND vault_source.product_slug = 'BRAND_000000_SUB'
    AND public.solidgate_checkout_core_is_canonical(vault_source)
    AND NOT vault_source.solidgate_checkout_identity_legacy
    AND vault_source.status IN ('completed', 'trialing', 'active', 'past_due')
    AND vault_source.solidgate_card_source_sequence IS NOT NULL
    AND vault_source.solidgate_payment_status IS DISTINCT FROM 'void_ok'
    AND vault_source.solidgate_chargeback_id IS NULL
    AND vault_source.solidgate_chargeback_status IS NULL
    AND COALESCE(vault_source.solidgate_chargeback_amount_cents, 0) = 0
    AND (
      (
        vault_source.solidgate_payment_status
          IN ('settle_ok', 'partial_settled')
        AND vault_source.solidgate_original_amount_cents > 0
        AND vault_source.amount_cents
              IS NOT DISTINCT FROM vault_source.solidgate_original_amount_cents
        AND vault_source.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
      )
      OR (
        vault_source.solidgate_payment_status = 'refunded'
        AND vault_source.solidgate_original_amount_cents > 0
        AND vault_source.solidgate_refunded_amount_cents > 0
        AND vault_source.solidgate_refunded_amount_cents
              < vault_source.solidgate_original_amount_cents
        AND vault_source.amount_cents IS NOT DISTINCT FROM (
          vault_source.solidgate_original_amount_cents
            - vault_source.solidgate_refunded_amount_cents
        )
      )
      OR (
        vault_source.solidgate_payment_status = 'auth_ok'
        AND vault_source.solidgate_payment_action = 'auth_0_amount'
        AND vault_source.solidgate_original_amount_cents = 0
        AND vault_source.amount_cents = 0
        AND vault_source.solidgate_refunded_amount_cents = 0
      )
    )
    AND (
      (
        vault.card_source_sequence
          IS NOT DISTINCT FROM v_order.solidgate_card_source_sequence
        AND vault.card_source_order_id = v_order.id
        AND vault.card_source_created_at IS NOT DISTINCT FROM v_order.created_at
      )
      OR vault.card_source_sequence > v_order.solidgate_card_source_sequence
    )
  FOR SHARE OF vault_source, vault;

  RETURN COALESCE(v_has_usable_token, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_solidgate_main_entitlement(
  p_payment_environment TEXT,
  p_order_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_fallback_expires_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_inserted_id UUID;
  v_existing_order_created_at TIMESTAMPTZ;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_id IS NULL
     OR p_user_id IS NULL
     OR p_product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR NULLIF(BTRIM(p_subscription_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_fallback_expires_at IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate main entitlement grant'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.solidgate_refunded_amount_cents IS DISTINCT FROM 0
     OR v_order.status NOT IN ('completed', 'trialing', 'active')
     OR v_order.solidgate_subscription_id IS DISTINCT FROM p_subscription_id
     OR NOT (
       COALESCE(
         v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled'),
         FALSE
       )
       OR (
         v_order.solidgate_payment_status IS NOT DISTINCT FROM 'auth_ok'
         AND p_amount_cents = 0
       )
     )
     OR (
       -- Card-first proof applies only to the zero-auth generation; a settled
       -- €1 special_free is validated by the paid-path checks above.
       v_order.tracking_metadata ->> 'funnel_code' = 'BRAND'
       AND v_order.tracking_metadata ->> 'funnel_variant' = 'special_free'
       AND v_order.tracking_metadata ->> 'product_slug' = 'special_free'
       AND v_order.solidgate_payment_action = 'auth_0_amount'
       AND NOT public.solidgate_special_free_card_ready(v_order.id)
     )
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR v_order.solidgate_chargeback_amount_cents > 0 THEN
    RETURN FALSE;
  END IF;

  IF v_order.user_id IS NULL THEN
    UPDATE public.orders AS candidate
    SET user_id = p_user_id,
        claimed_at = COALESCE(candidate.claimed_at, NOW())
    WHERE candidate.id = p_order_id
      AND candidate.user_id IS NULL;
  ELSIF v_order.user_id IS DISTINCT FROM p_user_id THEN
    RETURN FALSE;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  IF FOUND THEN
    IF v_entitlement.order_id IS NOT DISTINCT FROM p_order_id THEN
      RETURN v_entitlement.revoked_at IS NULL
        AND v_entitlement.status = 'active'
        AND v_entitlement.solidgate_subscription_id
              IS NOT DISTINCT FROM p_subscription_id;
    END IF;

    SELECT existing.created_at
    INTO v_existing_order_created_at
    FROM public.orders AS existing
    WHERE existing.id = v_entitlement.order_id;
    IF v_existing_order_created_at IS NOT NULL
       AND v_existing_order_created_at >= v_order.created_at THEN
      RETURN FALSE;
    END IF;

    UPDATE public.entitlements AS entitlement
    SET access_level = 'full',
        status = 'active',
        order_id = p_order_id,
        expires_at = p_fallback_expires_at,
        source = 'solidgate_grant',
        solidgate_subscription_id = p_subscription_id,
        revoked_at = NULL,
        updated_at = NOW()
    WHERE entitlement.id = v_entitlement.id;
    RETURN TRUE;
  END IF;

  INSERT INTO public.entitlements (
    payment_environment,
    user_id,
    product_slug,
    access_level,
    status,
    order_id,
    expires_at,
    source,
    solidgate_subscription_id,
    revoked_at,
    updated_at
  ) VALUES (
    p_payment_environment,
    p_user_id,
    p_product_slug,
    'full',
    'active',
    p_order_id,
    p_fallback_expires_at,
    'solidgate_grant',
    p_subscription_id,
    NULL,
    NOW()
  )
  ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  RETURN FOUND
    AND v_entitlement.order_id IS NOT DISTINCT FROM p_order_id
    AND v_entitlement.revoked_at IS NULL
    AND v_entitlement.status = 'active'
    AND v_entitlement.solidgate_subscription_id
          IS NOT DISTINCT FROM p_subscription_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_solidgate_oto_entitlement(
  p_payment_environment TEXT,
  p_order_db_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_access_level TEXT,
  p_expires_at TIMESTAMPTZ,
  p_solidgate_subscription_id TEXT,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_is_recurring_addon BOOLEAN;
  v_inserted_id UUID;
  v_existing_order_created_at TIMESTAMPTZ;
  v_existing_order_id UUID;
  v_step INTEGER;
  v_internal_slug TEXT;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_db_id IS NULL
     OR p_user_id IS NULL
     OR public.solidgate_oto_step_from_product_slug(p_product_slug) IS NULL
     OR p_access_level NOT IN ('full', 'trial')
     OR NULLIF(BTRIM(p_source), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate OTO entitlement grant'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment_order.*
  INTO v_order
  FROM public.orders AS payment_order
  WHERE payment_order.id = p_order_db_id
  FOR UPDATE;

  v_step := public.solidgate_oto_step_from_product_slug(p_product_slug);
  v_internal_slug := pg_catalog.split_part(v_order.solidgate_order_id, ':', 2);
  v_is_recurring_addon := p_product_slug = 'BRANDADDON_000000_SUB';
  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.session_id IS NULL
     OR v_order.solidgate_order_id IS NULL
     OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 1)
          IS DISTINCT FROM v_order.session_id::TEXT
     OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 3)
          !~ '^[1-9][0-9]{0,8}$'
     OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 4) <> ''
     OR public.solidgate_oto_step_from_internal_slug(v_internal_slug)
          IS DISTINCT FROM v_step
     OR v_order.solidgate_original_amount_cents IS NULL
     OR v_order.solidgate_original_amount_cents < 0
     OR v_order.currency !~ '^[a-z]{3}$'
     OR v_order.tracking_metadata IS NULL
     OR jsonb_typeof(v_order.tracking_metadata) <> 'object'
     OR v_order.tracking_metadata ->> 'session_id'
          IS DISTINCT FROM v_order.session_id::TEXT
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM v_internal_slug
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
     OR v_order.tracking_metadata ->> 'funnel_variant'
          IS DISTINCT FROM ('oto' || v_step::TEXT)
     OR v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_checkout_identity_bound_at IS NULL
     OR NULLIF(BTRIM(v_order.solidgate_customer_email), '') IS NULL
     OR NULLIF(BTRIM(v_order.solidgate_checkout_locale), '') IS NULL
     OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
     OR (
       v_is_recurring_addon
       AND (
         NULLIF(BTRIM(v_order.solidgate_product_id), '') IS NULL
         OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NULL
         OR v_order.tracking_metadata ? 'locale'
       )
     )
     OR (
       NOT v_is_recurring_addon
       AND (
         v_order.solidgate_product_id IS NOT NULL
         OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'locale'), '') IS NULL
         OR v_order.tracking_metadata ->> 'locale'
              IS DISTINCT FROM v_order.solidgate_checkout_locale
         OR v_order.tracking_metadata ? 'price_id'
       )
     )
     -- The local net must still equal the immutable provider gross. This
     -- rejects under-capture and every partial/full refund before access can be
     -- bootstrapped by a late browser response.
     OR v_order.amount_cents
          IS DISTINCT FROM v_order.solidgate_original_amount_cents
     OR v_order.solidgate_refunded_amount_cents IS DISTINCT FROM 0
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN FALSE;
  END IF;

  IF v_is_recurring_addon THEN
    -- The €1 intro generation settles a positive per-currency gross; only the
    -- retired zero-auth generation is rejected here. The exact amount was
    -- already bound to the immutably seeded order by the settle callback.
    IF v_order.solidgate_original_amount_cents <= 0
       OR v_order.status NOT IN ('trialing', 'active')
       OR v_order.solidgate_payment_status
            NOT IN ('auth_ok', 'settle_ok', 'partial_settled')
       OR NULLIF(BTRIM(p_solidgate_subscription_id), '') IS NULL
       OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
       OR p_access_level IS DISTINCT FROM 'trial'
       OR p_expires_at IS NULL THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF v_order.status IS DISTINCT FROM 'completed'
       OR v_order.solidgate_payment_status NOT IN ('settle_ok', 'partial_settled')
       OR v_order.solidgate_subscription_id IS NOT NULL
       OR p_solidgate_subscription_id IS NOT NULL
       OR p_access_level IS DISTINCT FROM 'full'
       OR p_expires_at IS NOT NULL THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF v_order.user_id IS NULL THEN
    UPDATE public.orders AS candidate
    SET user_id = p_user_id,
        claimed_at = COALESCE(candidate.claimed_at, NOW())
    WHERE candidate.id = p_order_db_id
      AND candidate.user_id IS NULL;
  ELSIF v_order.user_id IS DISTINCT FROM p_user_id THEN
    RETURN FALSE;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.entitlements (
      payment_environment,
      user_id,
      product_slug,
      access_level,
      order_id,
      expires_at,
      source,
      solidgate_subscription_id,
      status,
      revoked_at,
      updated_at
    ) VALUES (
      p_payment_environment,
      p_user_id,
      p_product_slug,
      p_access_level,
      p_order_db_id,
      p_expires_at,
      p_source,
      p_solidgate_subscription_id,
      'active',
      NULL,
      NOW()
    )
    ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
      RETURN TRUE;
    END IF;

    -- A webhook can win the unique-index race after our first SELECT. This
    -- command gets a fresh snapshot after waiting for that transaction.
    SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
    WHERE entitlement.payment_environment = p_payment_environment
      AND entitlement.user_id = p_user_id
      AND entitlement.product_slug = p_product_slug
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF v_entitlement.order_id IS NOT DISTINCT FROM p_order_db_id THEN
    -- A same-order webhook/grant replay never resets canceled/past-due state or
    -- overwrites an authoritative next_charge_at. It may only fill fields that
    -- an interrupted first writer left NULL.
    IF v_entitlement.status IS DISTINCT FROM 'active'
       OR v_entitlement.revoked_at IS NOT NULL
       OR v_entitlement.access_level IS DISTINCT FROM p_access_level
       OR (
         v_entitlement.solidgate_subscription_id IS NOT NULL
         AND v_entitlement.solidgate_subscription_id
               IS DISTINCT FROM p_solidgate_subscription_id
       ) THEN
      RETURN FALSE;
    END IF;

    UPDATE public.entitlements AS entitlement
    SET expires_at = COALESCE(entitlement.expires_at, p_expires_at),
        source = COALESCE(entitlement.source, p_source),
        solidgate_subscription_id = COALESCE(
          entitlement.solidgate_subscription_id,
          p_solidgate_subscription_id
        ),
        updated_at = CASE
          WHEN (entitlement.expires_at IS NULL AND p_expires_at IS NOT NULL)
            OR entitlement.source IS NULL
            OR (
              entitlement.solidgate_subscription_id IS NULL
              AND p_solidgate_subscription_id IS NOT NULL
            )
          THEN NOW()
          ELSE entitlement.updated_at
        END
    WHERE entitlement.id = v_entitlement.id;
    RETURN TRUE;
  END IF;

  -- A genuinely newer repurchase may replace an older entitlement. A late
  -- response from an older order can never clobber a newer PWA/session grant.
  IF v_entitlement.order_id IS NULL THEN
    RETURN FALSE;
  END IF;
  SELECT existing.created_at, existing.id
  INTO v_existing_order_created_at, v_existing_order_id
  FROM public.orders AS existing
  WHERE existing.id = v_entitlement.order_id;
  IF NOT FOUND OR (
    v_existing_order_created_at,
    v_existing_order_id
  ) >= (
    v_order.created_at,
    v_order.id
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.entitlements AS entitlement
  SET access_level = p_access_level,
      order_id = p_order_db_id,
      expires_at = p_expires_at,
      source = p_source,
      solidgate_subscription_id = p_solidgate_subscription_id,
      status = 'active',
      revoked_at = NULL,
      updated_at = NOW()
  WHERE entitlement.id = v_entitlement.id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_solidgate_pwa_entitlement(
  p_payment_environment TEXT,
  p_order_db_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_access_level TEXT,
  p_expires_at TIMESTAMPTZ,
  p_solidgate_subscription_id TEXT,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_is_subscription BOOLEAN;
  v_inserted_id UUID;
  v_existing_order_created_at TIMESTAMPTZ;
  v_existing_order_id UUID;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_db_id IS NULL
     OR p_user_id IS NULL
     OR NULLIF(BTRIM(p_product_slug), '') IS NULL
     OR p_access_level IS DISTINCT FROM 'full'
     OR NULLIF(BTRIM(p_source), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA entitlement grant'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment_order.*
  INTO v_order
  FROM public.orders AS payment_order
  WHERE payment_order.id = p_order_db_id
  FOR UPDATE;

  v_is_subscription := p_product_slug = 'BRANDADDON_000000_SUB';
  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_original_amount_cents IS NULL
     OR v_order.solidgate_original_amount_cents <= 0
     OR v_order.amount_cents IS DISTINCT FROM v_order.solidgate_original_amount_cents
     OR v_order.solidgate_refunded_amount_cents IS DISTINCT FROM 0
     OR v_order.solidgate_payment_status NOT IN ('settle_ok', 'partial_settled')
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN FALSE;
  END IF;

  IF v_is_subscription THEN
    IF v_order.status IS DISTINCT FROM 'active'
       OR NULLIF(BTRIM(v_order.solidgate_product_id), '') IS NULL
       OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NULL
       OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
       OR NULLIF(BTRIM(p_solidgate_subscription_id), '') IS NULL
       OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
       OR p_expires_at IS NULL THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF v_order.status IS DISTINCT FROM 'completed'
       OR v_order.solidgate_product_id IS NOT NULL
       OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
       OR v_order.solidgate_subscription_id IS NOT NULL
       OR p_solidgate_subscription_id IS NOT NULL
       OR p_expires_at IS NOT NULL THEN
      RETURN FALSE;
    END IF;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.entitlements (
      payment_environment, user_id, product_slug, access_level, order_id,
      expires_at, source, solidgate_subscription_id,
      status, revoked_at, updated_at
    ) VALUES (
      p_payment_environment, p_user_id, p_product_slug, p_access_level,
      p_order_db_id, p_expires_at, p_source,
      p_solidgate_subscription_id, 'active', NULL, NOW()
    )
    ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING
    RETURNING id INTO v_inserted_id;
    IF v_inserted_id IS NOT NULL THEN RETURN TRUE; END IF;

    SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
    WHERE entitlement.payment_environment = p_payment_environment
      AND entitlement.user_id = p_user_id
      AND entitlement.product_slug = p_product_slug
    FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
  END IF;

  IF v_entitlement.order_id IS NOT DISTINCT FROM p_order_db_id THEN
    IF v_entitlement.status IS DISTINCT FROM 'active'
       OR v_entitlement.revoked_at IS NOT NULL
       OR (
         v_entitlement.solidgate_subscription_id IS NOT NULL
         AND v_entitlement.solidgate_subscription_id
               IS DISTINCT FROM p_solidgate_subscription_id
       ) THEN
      RETURN FALSE;
    END IF;
    UPDATE public.entitlements AS entitlement
    SET expires_at = COALESCE(entitlement.expires_at, p_expires_at),
        source = COALESCE(entitlement.source, p_source),
        solidgate_subscription_id = COALESCE(
          entitlement.solidgate_subscription_id,
          p_solidgate_subscription_id
        ),
        updated_at = CASE
          WHEN (entitlement.expires_at IS NULL AND p_expires_at IS NOT NULL)
            OR entitlement.source IS NULL
            OR (
              entitlement.solidgate_subscription_id IS NULL
              AND p_solidgate_subscription_id IS NOT NULL
            )
          THEN NOW()
          ELSE entitlement.updated_at
        END
    WHERE entitlement.id = v_entitlement.id;
    RETURN TRUE;
  END IF;

  IF v_entitlement.order_id IS NULL THEN RETURN FALSE; END IF;
  SELECT existing.created_at, existing.id
  INTO v_existing_order_created_at, v_existing_order_id
  FROM public.orders AS existing
  WHERE existing.id = v_entitlement.order_id;
  IF NOT FOUND OR (
    v_existing_order_created_at,
    v_existing_order_id
  ) >= (
    v_order.created_at,
    v_order.id
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.entitlements AS entitlement
  SET access_level = p_access_level,
      order_id = p_order_db_id,
      expires_at = p_expires_at,
      source = p_source,
      solidgate_subscription_id = p_solidgate_subscription_id,
      status = 'active',
      revoked_at = NULL,
      updated_at = NOW()
  WHERE entitlement.id = v_entitlement.id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_solidgate_subscription_entitlement_lifecycle(
  p_payment_environment TEXT,
  p_order_db_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_solidgate_subscription_id TEXT,
  p_access_level TEXT,
  p_status TEXT,
  p_expires_at TIMESTAMPTZ,
  p_source TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_owner public.orders%ROWTYPE;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_db_id IS NULL
     OR p_user_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_product_slug, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_solidgate_subscription_id, '')), '') IS NULL
     OR p_access_level NOT IN ('full', 'trial', 'grace')
     OR p_status NOT IN ('active', 'past_due')
     OR (p_status = 'active' AND p_expires_at IS NULL)
     OR NULLIF(BTRIM(COALESCE(p_source, '')), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate subscription lifecycle mutation'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR SHARE;
  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
     OR v_order.solidgate_checkout_identity_legacy THEN
    RETURN 'invalid';
  END IF;
  IF v_order.status IN ('canceled', 'refunded', 'disputed')
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN 'reversed';
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF v_entitlement.order_id IS DISTINCT FROM p_order_db_id
     OR v_entitlement.solidgate_subscription_id
          IS DISTINCT FROM p_solidgate_subscription_id THEN
    IF v_entitlement.order_id IS NULL THEN RETURN 'invalid'; END IF;
    SELECT owner.*
    INTO v_owner
    FROM public.orders AS owner
    WHERE owner.id = v_entitlement.order_id;
    IF FOUND AND (
      (
        v_order.product_slug = 'BRAND_000000_SUB'
        AND v_owner.created_at >= v_order.created_at
      )
      OR (
        v_order.product_slug <> 'BRAND_000000_SUB'
        AND (v_owner.created_at, v_owner.id) >= (v_order.created_at, v_order.id)
      )
    ) THEN
      RETURN 'stale';
    END IF;
    RETURN 'invalid';
  END IF;

  IF v_entitlement.status = 'canceled' OR v_entitlement.revoked_at IS NOT NULL THEN
    RETURN 'lifecycle_owned';
  END IF;

  UPDATE public.entitlements AS entitlement
  -- An older positive snapshot may arrive after a paid renewal, including at
  -- the same provider timestamp. It cannot shorten that paid period or turn
  -- full access back into a trial. Recovery from past_due deliberately takes
  -- the actual paid expiry instead: the grace deadline is not paid time.
  SET access_level = CASE
        WHEN p_status = 'active' AND entitlement.status = 'active'
          AND entitlement.access_level = 'full' AND p_access_level = 'trial'
          THEN 'full'
        ELSE p_access_level
      END,
      expires_at = CASE
        WHEN p_status = 'active' AND entitlement.status = 'active'
          THEN GREATEST(p_expires_at, entitlement.expires_at)
        ELSE COALESCE(p_expires_at, entitlement.expires_at)
      END,
      source = p_source,
      status = p_status,
      revoked_at = NULL,
      updated_at = NOW()
  WHERE entitlement.id = v_entitlement.id;
  RETURN 'applied';
END;
$$;


-- ── card vaults ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.write_solidgate_session_vault_monotonic(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_source_order_id UUID,
  p_customer_account_id TEXT,
  p_card_token TEXT,
  p_card_brand TEXT,
  p_card_last4 TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_existing public.solidgate_session_vault%ROWTYPE;
  v_token TEXT := NULLIF(BTRIM(COALESCE(p_card_token, '')), '');
  v_brand TEXT := NULLIF(BTRIM(COALESCE(p_card_brand, '')), '');
  v_last4 TEXT := NULLIF(BTRIM(COALESCE(p_card_last4, '')), '');
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL
     OR p_source_order_id IS NULL
     OR p_customer_account_id IS DISTINCT FROM p_session_id::TEXT
     OR (v_last4 IS NOT NULL AND v_last4 !~ '^[0-9]{4}$') THEN
    RAISE EXCEPTION 'invalid Solidgate session vault source write'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_source_order_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.session_id = p_session_id
    AND candidate.psp = 'solidgate'
    AND candidate.product_slug = 'BRAND_000000_SUB'
    AND candidate.product_name = 'BRAND_000000_SUB'
  FOR SHARE;

  IF v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_card_source_sequence IS NULL
     OR v_order.status NOT IN (
       'pending', 'completed', 'trialing', 'active', 'past_due', 'canceled'
     )
     OR NOT (
       -- The accepted auth_ok handoff: a provider-confirmed PAID authorization
       -- whose immediate capture (settle_interval 0) is still in flight. The
       -- grant route publishes the reusable credential at this point so OTO1
       -- can charge one-click before settle; only the still-'pending' opener
       -- row qualifies, and a reversal (void/decline) is rejected below and by
       -- every later read of the source order.
       (
         v_order.status = 'pending'
         AND v_order.solidgate_payment_status = 'auth_ok'
         AND v_order.solidgate_payment_action = 'auth_settle'
         AND v_order.solidgate_original_amount_cents > 0
         AND v_order.amount_cents
               IS NOT DISTINCT FROM v_order.solidgate_original_amount_cents
         AND v_order.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
       )
       OR (
         v_order.status <> 'pending'
         AND v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled')
         AND v_order.solidgate_original_amount_cents > 0
         AND v_order.amount_cents
               IS NOT DISTINCT FROM v_order.solidgate_original_amount_cents
         AND v_order.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
       )
       OR (
         v_order.status <> 'pending'
         AND v_order.solidgate_payment_status = 'refunded'
         AND v_order.solidgate_original_amount_cents > 0
         AND v_order.solidgate_refunded_amount_cents > 0
         AND v_order.solidgate_refunded_amount_cents
               < v_order.solidgate_original_amount_cents
         AND v_order.amount_cents IS NOT DISTINCT FROM (
           v_order.solidgate_original_amount_cents
             - v_order.solidgate_refunded_amount_cents
         )
       )
       OR (
         v_order.status <> 'pending'
         AND v_order.solidgate_payment_status = 'auth_ok'
         AND v_order.solidgate_payment_action = 'auth_0_amount'
         AND v_order.solidgate_original_amount_cents = 0
         AND v_order.amount_cents = 0
         AND v_order.solidgate_refunded_amount_cents = 0
       )
     )
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN 'invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate-session-vault:' || p_payment_environment || ':' || p_session_id::TEXT,
      0
    )
  );
  SELECT vault.*
  INTO v_existing
  FROM public.solidgate_session_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.session_id = p_session_id
  FOR UPDATE;

  IF FOUND AND NOT v_existing.card_source_legacy THEN
    IF v_existing.card_source_order_id = p_source_order_id THEN
      IF v_existing.card_source_created_at IS DISTINCT FROM v_order.created_at
         OR v_existing.card_source_sequence
              IS DISTINCT FROM v_order.solidgate_card_source_sequence
         OR v_existing.customer_account_id IS DISTINCT FROM p_customer_account_id
         OR (
           v_existing.card_token IS NOT NULL
           AND v_token IS NOT NULL
           AND v_existing.card_token IS DISTINCT FROM v_token
         ) THEN
        RAISE EXCEPTION 'same Solidgate main order returned a different session token'
          USING ERRCODE = '23514';
      END IF;

      -- A poorer retry cannot erase richer evidence already recorded. A
      -- repeated tokenless callback is fully idempotent.
      IF v_existing.card_token IS NOT NULL OR v_token IS NULL THEN
        RETURN 'same';
      END IF;

      -- The same captured order may advance from a source watermark to a
      -- usable token when a later signed payload contains the transaction.
      PERFORM pg_catalog.set_config(
        'app.solidgate_session_vault_source_write',
        p_source_order_id::TEXT,
        TRUE
      );
      UPDATE public.solidgate_session_vault AS vault
      SET card_token = v_token,
          card_brand = v_brand,
          card_last4 = v_last4,
          updated_at = NOW()
      WHERE vault.payment_environment = p_payment_environment
        AND vault.session_id = p_session_id
        AND vault.card_source_order_id = p_source_order_id
        AND vault.card_token IS NULL;
      PERFORM pg_catalog.set_config(
        'app.solidgate_session_vault_source_write',
        '',
        TRUE
      );
      RETURN 'written';
    END IF;
    IF v_order.solidgate_card_source_sequence <= v_existing.card_source_sequence THEN
      RETURN 'stale';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'app.solidgate_session_vault_source_write',
    p_source_order_id::TEXT,
    TRUE
  );
  INSERT INTO public.solidgate_session_vault (
    payment_environment,
    session_id,
    customer_account_id,
    card_token,
    card_brand,
    card_last4,
    card_source_order_id,
    card_source_created_at,
    card_source_sequence,
    card_source_legacy,
    updated_at
  ) VALUES (
    p_payment_environment,
    p_session_id,
    p_customer_account_id,
    v_token,
    CASE WHEN v_token IS NULL THEN NULL ELSE v_brand END,
    CASE WHEN v_token IS NULL THEN NULL ELSE v_last4 END,
    p_source_order_id,
    v_order.created_at,
    v_order.solidgate_card_source_sequence,
    FALSE,
    NOW()
  )
  ON CONFLICT (payment_environment, session_id) DO UPDATE
  SET customer_account_id = EXCLUDED.customer_account_id,
      card_token = EXCLUDED.card_token,
      card_brand = EXCLUDED.card_brand,
      card_last4 = EXCLUDED.card_last4,
      card_source_order_id = EXCLUDED.card_source_order_id,
      card_source_created_at = EXCLUDED.card_source_created_at,
      card_source_sequence = EXCLUDED.card_source_sequence,
      card_source_legacy = FALSE,
      updated_at = NOW();
  PERFORM pg_catalog.set_config(
    'app.solidgate_session_vault_source_write',
    '',
    TRUE
  );
  RETURN 'written';
END;
$$;

CREATE OR REPLACE FUNCTION public.write_solidgate_account_vault_monotonic(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_source_kind TEXT,
  p_source_id UUID,
  p_source_claim_token UUID,
  p_card_token TEXT,
  p_card_brand TEXT,
  p_card_last4 TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source_created_at TIMESTAMPTZ;
  v_source_sequence BIGINT;
  v_source_text TEXT := p_source_id::TEXT;
  v_source_priority INTEGER;
  v_existing public.solidgate_account_vault%ROWTYPE;
  v_existing_priority INTEGER;
  v_attempt public.solidgate_card_update_attempts%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_pwa_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_session_origin_id UUID;
  v_token TEXT := NULLIF(BTRIM(COALESCE(p_card_token, '')), '');
  v_brand TEXT := NULLIF(BTRIM(COALESCE(p_card_brand, '')), '');
  v_last4 TEXT := NULLIF(BTRIM(COALESCE(p_card_last4, '')), '');
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR p_source_id IS NULL
     OR (v_last4 IS NOT NULL AND v_last4 !~ '^[0-9]{4}$') THEN
    RAISE EXCEPTION 'invalid Solidgate account vault source write'
      USING ERRCODE = '22023';
  END IF;

  IF p_source_kind = 'card_update' THEN
    -- A zero-auth update proves a new card only when the provider supplies its
    -- reusable token. Captured charge orders may still create watermarks.
    IF v_token IS NULL THEN RETURN 'invalid'; END IF;
    SELECT candidate.*
    INTO STRICT v_attempt
    FROM public.solidgate_card_update_attempts AS candidate
    WHERE candidate.id = p_source_id
      AND candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.is_current
    FOR SHARE;
    IF v_attempt.state IS DISTINCT FROM 'applying'
       OR v_attempt.apply_token IS DISTINCT FROM p_source_claim_token THEN
      RETURN 'invalid';
    END IF;
    v_source_created_at := v_attempt.created_at;
    v_source_sequence := v_attempt.source_sequence;
    v_source_priority := 3;
  ELSIF p_source_kind = 'pwa_order' THEN
    IF p_source_claim_token IS NOT NULL THEN RETURN 'invalid'; END IF;
    SELECT candidate.*
    INTO STRICT v_order
    FROM public.orders AS candidate
    WHERE candidate.id = p_source_id
      AND candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.session_id IS NULL
      AND candidate.psp = 'solidgate'
    FOR SHARE;
    SELECT state.*
    INTO STRICT v_pwa_state
    FROM public.solidgate_pwa_purchase_states AS state
    WHERE state.payment_environment = p_payment_environment
      AND state.user_id = p_user_id
      AND state.order_db_id = p_source_id
    FOR SHARE;
    IF v_order.solidgate_checkout_identity_legacy
       OR v_order.solidgate_card_source_sequence IS NULL
       OR v_order.status NOT IN (
         'completed', 'trialing', 'active', 'past_due', 'canceled'
       )
       OR NOT (
         (
           v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled')
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.amount_cents
                 IS NOT DISTINCT FROM v_order.solidgate_original_amount_cents
           AND v_order.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
         )
         OR (
           v_order.solidgate_payment_status = 'refunded'
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents
                 < v_order.solidgate_original_amount_cents
           AND v_order.amount_cents IS NOT DISTINCT FROM (
             v_order.solidgate_original_amount_cents
               - v_order.solidgate_refunded_amount_cents
           )
         )
       )
       OR v_order.solidgate_chargeback_id IS NOT NULL
       OR v_order.solidgate_chargeback_status IS NOT NULL
       OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0
       OR v_pwa_state.purchase_mode IS DISTINCT FROM 'hosted_form'
       OR v_pwa_state.last_result_kind IS DISTINCT FROM 'captured' THEN
      RETURN 'invalid';
    END IF;
    v_source_created_at := v_order.created_at;
    v_source_sequence := v_order.solidgate_card_source_sequence;
    v_source_priority := 2;
  ELSIF p_source_kind = 'main_order' THEN
    IF p_source_claim_token IS NOT NULL THEN RETURN 'invalid'; END IF;
    SELECT candidate.*
    INTO STRICT v_order
    FROM public.orders AS candidate
    WHERE candidate.id = p_source_id
      AND candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.session_id IS NOT NULL
      AND candidate.psp = 'solidgate'
      AND candidate.product_slug = 'BRAND_000000_SUB'
      AND candidate.product_name = 'BRAND_000000_SUB'
    FOR SHARE;
    IF v_order.solidgate_checkout_identity_legacy
       OR v_order.solidgate_card_source_sequence IS NULL
       OR v_order.status NOT IN (
         'completed', 'trialing', 'active', 'past_due', 'canceled'
       )
       OR NOT (
         (
           v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled')
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.amount_cents
                 IS NOT DISTINCT FROM v_order.solidgate_original_amount_cents
           AND v_order.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
         )
         OR (
           v_order.solidgate_payment_status = 'refunded'
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents
                 < v_order.solidgate_original_amount_cents
           AND v_order.amount_cents IS NOT DISTINCT FROM (
             v_order.solidgate_original_amount_cents
               - v_order.solidgate_refunded_amount_cents
           )
         )
         OR (
           v_order.solidgate_payment_status = 'auth_ok'
           AND v_order.solidgate_payment_action = 'auth_0_amount'
           AND v_order.solidgate_original_amount_cents = 0
           AND v_order.amount_cents = 0
           AND v_order.solidgate_refunded_amount_cents = 0
         )
       )
       OR v_order.solidgate_payment_status = 'void_ok'
       OR v_order.solidgate_chargeback_id IS NOT NULL
       OR v_order.solidgate_chargeback_status IS NOT NULL
       OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
      RETURN 'invalid';
    END IF;
    v_source_created_at := v_order.created_at;
    v_source_sequence := v_order.solidgate_card_source_sequence;
    v_source_priority := 1;
    v_session_origin_id := v_order.session_id;
  ELSE
    RETURN 'invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate-account-vault:' || p_payment_environment || ':' || p_user_id::TEXT,
      0
    )
  );
  SELECT vault.*
  INTO v_existing
  FROM public.solidgate_account_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    v_existing_priority := CASE v_existing.card_source_kind
      WHEN 'card_update' THEN 3
      WHEN 'pwa_order' THEN 2
      WHEN 'main_order' THEN 1
      ELSE 0
    END;
    IF v_existing.card_source_kind = p_source_kind
       AND v_existing.card_source_id = v_source_text THEN
      IF v_existing.card_source_created_at IS DISTINCT FROM v_source_created_at
         OR v_existing.card_source_sequence IS DISTINCT FROM v_source_sequence
         OR v_existing.customer_account_id IS DISTINCT FROM p_user_id::TEXT
         OR (
           v_existing.card_token IS NOT NULL
           AND v_token IS NOT NULL
           AND v_existing.card_token IS DISTINCT FROM v_token
         ) THEN
        RAISE EXCEPTION 'same Solidgate vault source returned a different token'
          USING ERRCODE = '23514';
      END IF;

      -- A tokenless replay cannot erase richer evidence from this source.
      IF v_existing.card_token IS NOT NULL THEN
        PERFORM public.enqueue_solidgate_subscription_token_sync(
          p_payment_environment,
          p_user_id
        );
        RETURN 'same';
      END IF;

      -- Replaying a tokenless winner repairs any awaiting rows introduced by
      -- a delayed entitlement grant without making them claimable.
      IF v_token IS NULL THEN
        PERFORM public.fence_solidgate_subscription_token_sync_for_tokenless_source(
          p_payment_environment,
          p_user_id,
          p_source_kind,
          v_source_created_at,
          v_source_sequence,
          v_source_text
        );
        RETURN 'same';
      END IF;

      -- Fill the exact tokenless generation, then release only the jobs that
      -- this generation fenced. The usable token is durable before any worker
      -- can claim them.
      PERFORM pg_catalog.set_config(
        'app.solidgate_vault_source_write',
        p_source_kind || ':' || v_source_text,
        TRUE
      );
      UPDATE public.solidgate_account_vault AS vault
      SET card_token = v_token,
          card_brand = v_brand,
          card_last4 = v_last4,
          session_origin_id = COALESCE(
            v_session_origin_id,
            vault.session_origin_id
          ),
          updated_at = NOW()
      WHERE vault.payment_environment = p_payment_environment
        AND vault.user_id = p_user_id
        AND vault.card_source_kind = p_source_kind
        AND vault.card_source_id = v_source_text
        AND vault.card_token IS NULL;
      PERFORM pg_catalog.set_config(
        'app.solidgate_vault_source_write',
        '',
        TRUE
      );

      -- Enqueue selects only exact billable subscriptions whose own order is
      -- older than this source; unsafe/nonbillable awaiting rows stay fenced.
      PERFORM public.enqueue_solidgate_subscription_token_sync(
        p_payment_environment,
        p_user_id
      );
      RETURN 'written';
    END IF;
    IF (
      v_source_sequence,
      v_source_priority,
      v_source_text
    ) <= (
      v_existing.card_source_sequence,
      v_existing_priority,
      v_existing.card_source_id
    ) THEN
      -- Re-enqueue a previously failed job for the actual current winner. A
      -- stale browser return never queues its own obsolete token.
      PERFORM public.enqueue_solidgate_subscription_token_sync(
        p_payment_environment,
        p_user_id
      );
      RETURN 'stale';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'app.solidgate_vault_source_write',
    p_source_kind || ':' || v_source_text,
    TRUE
  );
  INSERT INTO public.solidgate_account_vault (
    user_id,
    payment_environment,
    customer_account_id,
    card_token,
    card_brand,
    card_last4,
    session_origin_id,
    card_source_kind,
    card_source_created_at,
    card_source_sequence,
    card_source_id,
    updated_at
  ) VALUES (
    p_user_id,
    p_payment_environment,
    p_user_id::TEXT,
    v_token,
    CASE WHEN v_token IS NULL THEN NULL ELSE v_brand END,
    CASE WHEN v_token IS NULL THEN NULL ELSE v_last4 END,
    v_session_origin_id,
    p_source_kind,
    v_source_created_at,
    v_source_sequence,
    v_source_text,
    NOW()
  )
  ON CONFLICT (payment_environment, user_id) DO UPDATE
  SET customer_account_id = EXCLUDED.customer_account_id,
      card_token = EXCLUDED.card_token,
      card_brand = EXCLUDED.card_brand,
      card_last4 = EXCLUDED.card_last4,
      session_origin_id = COALESCE(
        EXCLUDED.session_origin_id,
        public.solidgate_account_vault.session_origin_id
      ),
      card_source_kind = EXCLUDED.card_source_kind,
      card_source_created_at = EXCLUDED.card_source_created_at,
      card_source_sequence = EXCLUDED.card_source_sequence,
      card_source_id = EXCLUDED.card_source_id,
      updated_at = NOW();
  PERFORM pg_catalog.set_config(
    'app.solidgate_vault_source_write',
    '',
    TRUE
  );

  IF v_token IS NULL THEN
    PERFORM public.fence_solidgate_subscription_token_sync_for_tokenless_source(
      p_payment_environment,
      p_user_id,
      p_source_kind,
      v_source_created_at,
      v_source_sequence,
      v_source_text
    );
  ELSE
    PERFORM public.enqueue_solidgate_subscription_token_sync(
      p_payment_environment,
      p_user_id
    );
  END IF;
  RETURN 'written';
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_solidgate_session_vault_monotonic(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_session_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_card public.solidgate_session_vault%ROWTYPE;
BEGIN
  SELECT vault.*
  INTO v_card
  FROM public.solidgate_session_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.session_id = p_session_id
  FOR SHARE;
  IF NOT FOUND
     OR v_card.card_source_legacy
     OR v_card.card_source_order_id IS NULL
     OR v_card.card_source_sequence IS NULL THEN
    RETURN 'missing';
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = v_card.card_source_order_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.session_id = p_session_id
    AND candidate.psp = 'solidgate'
    AND candidate.product_slug = 'BRAND_000000_SUB'
    AND candidate.product_name = 'BRAND_000000_SUB'
    AND candidate.status IN (
      'completed', 'trialing', 'active', 'past_due', 'canceled'
    )
    AND NOT candidate.solidgate_checkout_identity_legacy
    AND candidate.solidgate_card_source_sequence = v_card.card_source_sequence
  FOR SHARE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;

  RETURN public.write_solidgate_account_vault_monotonic(
    p_payment_environment,
    p_user_id,
    'main_order',
    v_order.id,
    NULL,
    v_card.card_token,
    v_card.card_brand,
    v_card.card_last4
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.write_solidgate_session_vault_with_method(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_source_order_id UUID,
  p_customer_account_id TEXT,
  p_card_token TEXT,
  p_card_brand TEXT,
  p_card_last4 TEXT,
  p_original_payment_method TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result TEXT;
  v_current public.solidgate_session_vault%ROWTYPE;
  v_token TEXT := NULLIF(BTRIM(COALESCE(p_card_token, '')), '');
BEGIN
  IF p_original_payment_method IS NOT NULL
     AND (
       v_token IS NULL
       OR p_original_payment_method NOT IN (
         'card',
         'apple-pay',
         'google-pay',
         'network-token',
         'click-to-pay'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate session token origin'
      USING ERRCODE = '22023';
  END IF;

  v_result := public.write_solidgate_session_vault_monotonic(
    p_payment_environment,
    p_session_id,
    p_source_order_id,
    p_customer_account_id,
    p_card_token,
    p_card_brand,
    p_card_last4
  );
  IF v_result NOT IN ('written', 'same')
     OR p_original_payment_method IS NULL THEN
    RETURN v_result;
  END IF;

  SELECT vault.*
  INTO v_current
  FROM public.solidgate_session_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.session_id = p_session_id
    AND NOT vault.card_source_legacy
    AND vault.card_source_order_id = p_source_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN v_result; END IF;
  IF v_current.card_token IS NULL THEN
    RAISE EXCEPTION 'Solidgate session token origin has no exact token'
      USING ERRCODE = '23514';
  END IF;
  IF v_current.card_original_payment_method IS NOT NULL
     AND v_current.card_original_payment_method
           IS DISTINCT FROM p_original_payment_method THEN
    RAISE EXCEPTION 'same Solidgate session token has conflicting origins'
      USING ERRCODE = '23514';
  END IF;
  IF v_current.card_original_payment_method IS NULL THEN
    PERFORM pg_catalog.set_config(
      'app.solidgate_session_vault_source_write',
      p_source_order_id::TEXT,
      TRUE
    );
    UPDATE public.solidgate_session_vault AS vault
    SET card_original_payment_method = p_original_payment_method,
        updated_at = NOW()
    WHERE vault.payment_environment = p_payment_environment
      AND vault.session_id = p_session_id
      AND NOT vault.card_source_legacy
      AND vault.card_source_order_id = p_source_order_id
      AND vault.card_token IS NOT NULL
      AND vault.card_original_payment_method IS NULL;
    PERFORM pg_catalog.set_config(
      'app.solidgate_session_vault_source_write',
      '',
      TRUE
    );
    RETURN 'written';
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.write_solidgate_account_vault_with_method(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_source_kind TEXT,
  p_source_id UUID,
  p_source_claim_token UUID,
  p_card_token TEXT,
  p_card_brand TEXT,
  p_card_last4 TEXT,
  p_original_payment_method TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result TEXT;
  v_current public.solidgate_account_vault%ROWTYPE;
  v_source_text TEXT := p_source_id::TEXT;
  v_token TEXT := NULLIF(BTRIM(COALESCE(p_card_token, '')), '');
BEGIN
  IF p_original_payment_method IS NOT NULL
     AND (
       v_token IS NULL
       OR p_original_payment_method NOT IN (
         'card',
         'apple-pay',
         'google-pay',
         'network-token',
         'click-to-pay'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate account token origin'
      USING ERRCODE = '22023';
  END IF;

  v_result := public.write_solidgate_account_vault_monotonic(
    p_payment_environment,
    p_user_id,
    p_source_kind,
    p_source_id,
    p_source_claim_token,
    p_card_token,
    p_card_brand,
    p_card_last4
  );
  IF v_result NOT IN ('written', 'same')
     OR p_original_payment_method IS NULL THEN
    RETURN v_result;
  END IF;

  SELECT vault.*
  INTO v_current
  FROM public.solidgate_account_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.user_id = p_user_id
    AND vault.card_source_kind = p_source_kind
    AND vault.card_source_id = v_source_text
  FOR UPDATE;
  IF NOT FOUND THEN RETURN v_result; END IF;
  IF v_current.card_token IS NULL THEN
    RAISE EXCEPTION 'Solidgate account token origin has no exact token'
      USING ERRCODE = '23514';
  END IF;
  IF v_current.card_original_payment_method IS NOT NULL
     AND v_current.card_original_payment_method
           IS DISTINCT FROM p_original_payment_method THEN
    RAISE EXCEPTION 'same Solidgate account token has conflicting origins'
      USING ERRCODE = '23514';
  END IF;
  IF v_current.card_original_payment_method IS NULL THEN
    PERFORM pg_catalog.set_config(
      'app.solidgate_vault_source_write',
      p_source_kind || ':' || v_source_text,
      TRUE
    );
    UPDATE public.solidgate_account_vault AS vault
    SET card_original_payment_method = p_original_payment_method,
        updated_at = NOW()
    WHERE vault.payment_environment = p_payment_environment
      AND vault.user_id = p_user_id
      AND vault.card_source_kind = p_source_kind
      AND vault.card_source_id = v_source_text
      AND vault.card_token IS NOT NULL
      AND vault.card_original_payment_method IS NULL;
    PERFORM pg_catalog.set_config(
      'app.solidgate_vault_source_write',
      '',
      TRUE
    );
    RETURN 'written';
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_solidgate_session_vault_with_method(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_session_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result TEXT;
  v_session public.solidgate_session_vault%ROWTYPE;
  v_account public.solidgate_account_vault%ROWTYPE;
BEGIN
  v_result := public.promote_solidgate_session_vault_monotonic(
    p_payment_environment,
    p_user_id,
    p_session_id
  );
  IF v_result NOT IN ('written', 'same') THEN RETURN v_result; END IF;

  SELECT vault.*
  INTO v_session
  FROM public.solidgate_session_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.session_id = p_session_id
    AND NOT vault.card_source_legacy
    AND vault.card_source_order_id IS NOT NULL
  FOR SHARE;
  IF NOT FOUND OR v_session.card_original_payment_method IS NULL THEN
    RETURN v_result;
  END IF;
  IF v_session.card_token IS NULL THEN
    RAISE EXCEPTION 'Solidgate promoted token origin has no exact token'
      USING ERRCODE = '23514';
  END IF;

  SELECT vault.*
  INTO v_account
  FROM public.solidgate_account_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.user_id = p_user_id
    AND vault.card_source_kind = 'main_order'
    AND vault.card_source_id = v_session.card_source_order_id::TEXT
  FOR UPDATE;
  IF NOT FOUND THEN RETURN v_result; END IF;
  IF v_account.card_original_payment_method IS NOT NULL
     AND v_account.card_original_payment_method
           IS DISTINCT FROM v_session.card_original_payment_method THEN
    RAISE EXCEPTION 'promoted Solidgate token has conflicting origins'
      USING ERRCODE = '23514';
  END IF;
  IF v_account.card_original_payment_method IS NULL THEN
    PERFORM pg_catalog.set_config(
      'app.solidgate_vault_source_write',
      'main_order:' || v_session.card_source_order_id::TEXT,
      TRUE
    );
    UPDATE public.solidgate_account_vault AS vault
    SET card_original_payment_method = v_session.card_original_payment_method,
        updated_at = NOW()
    WHERE vault.payment_environment = p_payment_environment
      AND vault.user_id = p_user_id
      AND vault.card_source_kind = 'main_order'
      AND vault.card_source_id = v_session.card_source_order_id::TEXT
      AND vault.card_token IS NOT NULL
      AND vault.card_original_payment_method IS NULL;
    PERFORM pg_catalog.set_config(
      'app.solidgate_vault_source_write',
      '',
      TRUE
    );
    RETURN 'written';
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_solidgate_legacy_session_vault(
  p_payment_environment TEXT,
  p_session_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_cleared BOOLEAN;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate legacy session-vault clear'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'app.solidgate_session_vault_source_write',
    'operator-clear:' || p_session_id::TEXT,
    TRUE
  );
  UPDATE public.solidgate_session_vault AS vault
  SET card_token = NULL,
      card_brand = NULL,
      card_last4 = NULL,
      card_source_order_id = NULL,
      card_source_created_at = NULL,
      card_source_sequence = NULL,
      card_source_legacy = FALSE,
      updated_at = NOW()
  WHERE vault.payment_environment = p_payment_environment
    AND vault.session_id = p_session_id
    AND vault.card_source_legacy;
  v_cleared := FOUND;
  PERFORM pg_catalog.set_config(
    'app.solidgate_session_vault_source_write',
    '',
    TRUE
  );
  RETURN v_cleared;
END;
$$;


-- ── card update + subscription token sync ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.open_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_candidate_order_id TEXT,
  p_customer_email TEXT,
  p_checkout_locale TEXT,
  p_builder_token UUID
)
RETURNS TABLE (
  attempt_id UUID,
  solidgate_order_id TEXT,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  attempt_state TEXT,
  merchant_data JSONB,
  is_new BOOLEAN,
  should_build BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current public.solidgate_card_update_attempts%ROWTYPE;
  v_email TEXT := LOWER(BTRIM(COALESCE(p_customer_email, '')));
  v_locale TEXT := BTRIM(COALESCE(p_checkout_locale, ''));
  v_expected_prefix TEXT := 'u-' || p_user_id::TEXT || ':card_update:';
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR p_builder_token IS NULL
     OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR CHAR_LENGTH(v_email) > 320
     OR v_locale NOT IN (
       'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
       'he', 'pl', 'hr', 'da', 'ja'
     )
     OR LEFT(COALESCE(p_candidate_order_id, ''), LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR pg_catalog.split_part(p_candidate_order_id, ':', 3) !~ '^[1-9][0-9]{0,18}$'
     OR pg_catalog.split_part(p_candidate_order_id, ':', 4) <> '' THEN
    RAISE EXCEPTION 'invalid Solidgate card-update attempt binding'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate-card-update:' || p_payment_environment || ':' || p_user_id::TEXT,
      0
    )
  );

  SELECT candidate.*
  INTO v_current
  FROM public.solidgate_card_update_attempts AS candidate
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.is_current
  FOR UPDATE;

  IF FOUND AND v_current.state IN ('building', 'issued', 'applying') THEN
    IF v_current.state = 'building'
       AND v_current.builder_started_at < NOW() - INTERVAL '30 seconds' THEN
      UPDATE public.solidgate_card_update_attempts AS candidate
      SET builder_token = p_builder_token,
          builder_started_at = NOW(),
          updated_at = NOW()
      WHERE candidate.id = v_current.id
      RETURNING candidate.* INTO v_current;

      RETURN QUERY SELECT
        v_current.id,
        v_current.solidgate_order_id,
        v_current.customer_email,
        v_current.checkout_locale,
        v_current.state,
        v_current.merchant_data,
        FALSE,
        TRUE;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      v_current.id,
      v_current.solidgate_order_id,
      v_current.customer_email,
      v_current.checkout_locale,
      v_current.state,
      v_current.merchant_data,
      FALSE,
      FALSE;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE public.solidgate_card_update_attempts AS candidate
    SET is_current = FALSE,
        updated_at = NOW()
    WHERE candidate.id = v_current.id;
  END IF;

  INSERT INTO public.solidgate_card_update_attempts (
    payment_environment,
    user_id,
    solidgate_order_id,
    customer_email,
    checkout_locale,
    state,
    builder_token,
    builder_started_at
  ) VALUES (
    p_payment_environment,
    p_user_id,
    p_candidate_order_id,
    v_email,
    v_locale,
    'building',
    p_builder_token,
    NOW()
  )
  RETURNING * INTO v_current;

  RETURN QUERY SELECT
    v_current.id,
    v_current.solidgate_order_id,
    v_current.customer_email,
    v_current.checkout_locale,
    v_current.state,
    v_current.merchant_data,
    TRUE,
    TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_attempt_id UUID,
  p_solidgate_order_id TEXT,
  p_builder_token UUID,
  p_merchant_data JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.solidgate_card_update_attempts%ROWTYPE;
BEGIN
  IF p_merchant_data IS NULL OR jsonb_typeof(p_merchant_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid Solidgate card-update merchant data'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO STRICT v_attempt
  FROM public.solidgate_card_update_attempts AS candidate
  WHERE candidate.id = p_attempt_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.is_current
  FOR UPDATE;

  IF v_attempt.state = 'issued'
     AND v_attempt.merchant_data = p_merchant_data THEN
    RETURN TRUE;
  END IF;
  IF v_attempt.state IS DISTINCT FROM 'building'
     OR v_attempt.builder_token IS DISTINCT FROM p_builder_token THEN
    RETURN FALSE;
  END IF;

  UPDATE public.solidgate_card_update_attempts AS candidate
  SET state = 'issued',
      merchant_data = p_merchant_data,
      builder_token = NULL,
      builder_started_at = NULL,
      updated_at = NOW()
  WHERE candidate.id = v_attempt.id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_order_id TEXT,
  p_apply_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.solidgate_card_update_attempts%ROWTYPE;
BEGIN
  IF p_apply_token IS NULL THEN
    RAISE EXCEPTION 'missing Solidgate card-update apply token'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate-card-update:' || p_payment_environment || ':' || p_user_id::TEXT,
      0
    )
  );
  SELECT candidate.*
  INTO v_attempt
  FROM public.solidgate_card_update_attempts AS candidate
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
  FOR UPDATE;

  IF NOT FOUND OR NOT v_attempt.is_current THEN RETURN 'rejected'; END IF;
  IF v_attempt.state = 'completed' THEN RETURN 'completed'; END IF;
  IF v_attempt.state = 'failed' OR v_attempt.state = 'building' THEN RETURN 'rejected'; END IF;
  IF v_attempt.state = 'applying'
     AND v_attempt.apply_token IS DISTINCT FROM p_apply_token
     AND v_attempt.apply_started_at >= NOW() - INTERVAL '30 seconds' THEN
    RETURN 'busy';
  END IF;

  UPDATE public.solidgate_card_update_attempts AS candidate
  SET state = 'applying',
      apply_token = p_apply_token,
      apply_started_at = NOW(),
      updated_at = NOW()
  WHERE candidate.id = v_attempt.id;
  RETURN 'acquired';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_order_id TEXT
)
RETURNS TABLE (
  attempt_id UUID,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  source_created_at TIMESTAMPTZ,
  attempt_state TEXT,
  is_current BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    candidate.id,
    candidate.customer_email,
    candidate.checkout_locale,
    candidate.created_at,
    candidate.state,
    candidate.is_current
  FROM public.solidgate_card_update_attempts AS candidate
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
$$;

CREATE OR REPLACE FUNCTION public.release_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_order_id TEXT,
  p_apply_token UUID,
  p_provider_status TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.solidgate_card_update_attempts AS candidate
  SET state = 'issued',
      apply_token = NULL,
      apply_started_at = NULL,
      last_provider_status = p_provider_status,
      updated_at = NOW()
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.is_current
    AND candidate.state = 'applying'
    AND candidate.apply_token = p_apply_token
  RETURNING TRUE
$$;

CREATE OR REPLACE FUNCTION public.complete_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_order_id TEXT,
  p_apply_token UUID,
  p_provider_status TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.solidgate_card_update_attempts AS candidate
  SET state = 'completed',
      apply_token = NULL,
      apply_started_at = NULL,
      last_provider_status = p_provider_status,
      completed_at = NOW(),
      updated_at = NOW()
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.is_current
    AND candidate.state = 'applying'
    AND candidate.apply_token = p_apply_token
  RETURNING TRUE
$$;

CREATE OR REPLACE FUNCTION public.record_solidgate_card_update_attempt_status(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_order_id TEXT,
  p_provider_status TEXT,
  p_terminal BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.solidgate_card_update_attempts AS candidate
  SET state = CASE WHEN p_terminal THEN 'failed' ELSE candidate.state END,
      builder_token = CASE WHEN p_terminal THEN NULL ELSE candidate.builder_token END,
      builder_started_at = CASE WHEN p_terminal THEN NULL ELSE candidate.builder_started_at END,
      apply_token = CASE WHEN p_terminal THEN NULL ELSE candidate.apply_token END,
      apply_started_at = CASE WHEN p_terminal THEN NULL ELSE candidate.apply_started_at END,
      last_provider_status = p_provider_status,
      updated_at = NOW()
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.solidgate_order_id = p_solidgate_order_id
    AND candidate.is_current
    AND candidate.state IN ('issued', 'applying');
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.solidgate_subscription_token_sync_is_billable(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_subscription_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.entitlements AS entitlement
    JOIN public.orders AS subscription_order
      ON subscription_order.id = entitlement.order_id
     AND subscription_order.payment_environment = entitlement.payment_environment
     AND subscription_order.user_id = entitlement.user_id
     AND subscription_order.solidgate_subscription_id
           = entitlement.solidgate_subscription_id
     AND subscription_order.product_slug = entitlement.product_slug
    WHERE entitlement.payment_environment = p_payment_environment
      AND entitlement.user_id = p_user_id
      AND entitlement.solidgate_subscription_id = p_solidgate_subscription_id
      AND entitlement.status IN ('active', 'past_due')
      AND entitlement.revoked_at IS NULL
      AND subscription_order.psp = 'solidgate'
      AND subscription_order.status IN ('trialing', 'active', 'past_due')
      AND NOT subscription_order.solidgate_checkout_identity_legacy
      AND public.solidgate_checkout_core_is_canonical(subscription_order)
      -- A partial refund intentionally retains access and recurring billing;
      -- the terminal `refunded` status is already excluded by the allowlist.
      AND subscription_order.solidgate_payment_status IS DISTINCT FROM 'void_ok'
      AND subscription_order.solidgate_chargeback_id IS NULL
      AND subscription_order.solidgate_chargeback_status IS NULL
      AND COALESCE(subscription_order.solidgate_chargeback_amount_cents, 0) = 0
  )
$$;

CREATE OR REPLACE FUNCTION public.enqueue_solidgate_subscription_token_sync(
  p_payment_environment TEXT,
  p_user_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queued INTEGER := 0;
  v_vault public.solidgate_account_vault%ROWTYPE;
BEGIN
  SELECT candidate.*
  INTO v_vault
  FROM public.solidgate_account_vault AS candidate
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
  FOR SHARE;

  IF NOT FOUND
     OR NULLIF(BTRIM(v_vault.card_token), '') IS NULL
     OR v_vault.card_source_kind = 'legacy' THEN
    RETURN 0;
  END IF;

  INSERT INTO public.solidgate_subscription_token_sync_jobs AS job (
    payment_environment,
    user_id,
    solidgate_subscription_id,
    desired_source_kind,
    desired_source_created_at,
    desired_source_sequence,
    desired_source_id,
    status,
    next_attempt_at,
    applied_at,
    last_error,
    updated_at
  )
  SELECT DISTINCT
    p_payment_environment,
    p_user_id,
    entitlement.solidgate_subscription_id,
    v_vault.card_source_kind,
    v_vault.card_source_created_at,
    v_vault.card_source_sequence,
    v_vault.card_source_id,
    'pending'::TEXT,
    NOW(),
    NULL::TIMESTAMPTZ,
    NULL::TEXT,
    NOW()
  FROM public.entitlements AS entitlement
  JOIN public.orders AS subscription_order
    ON subscription_order.id = entitlement.order_id
   AND subscription_order.payment_environment = entitlement.payment_environment
   AND subscription_order.user_id = entitlement.user_id
   AND subscription_order.solidgate_subscription_id
         = entitlement.solidgate_subscription_id
   AND subscription_order.product_slug = entitlement.product_slug
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.status IN ('active', 'past_due')
    AND NULLIF(BTRIM(entitlement.solidgate_subscription_id), '') IS NOT NULL
    -- The provider subscription was already created with the card used by its
    -- own order. Only a strictly later account-card source needs an external
    -- token update; equal is redundant and older would roll the subscription
    -- back to a card the buyer did not use for this purchase.
    AND v_vault.card_source_sequence
          > subscription_order.solidgate_card_source_sequence
    AND public.solidgate_subscription_token_sync_is_billable(
      p_payment_environment,
      p_user_id,
      entitlement.solidgate_subscription_id
    )
  ON CONFLICT (payment_environment, user_id, solidgate_subscription_id)
  DO UPDATE SET
    desired_source_kind = EXCLUDED.desired_source_kind,
    desired_source_created_at = EXCLUDED.desired_source_created_at,
    desired_source_sequence = EXCLUDED.desired_source_sequence,
    desired_source_id = EXCLUDED.desired_source_id,
    status = CASE
      WHEN job.status = 'processing' THEN 'processing'
      ELSE 'pending'
    END,
    claim_token = CASE
      WHEN job.status = 'processing' THEN job.claim_token
      ELSE NULL
    END,
    processing_started_at = CASE
      WHEN job.status = 'processing' THEN job.processing_started_at
      ELSE NULL
    END,
    next_attempt_at = NOW(),
    applied_at = NULL,
    last_error = NULL,
    updated_at = NOW()
  WHERE (
    EXCLUDED.desired_source_sequence,
    CASE EXCLUDED.desired_source_kind
      WHEN 'card_update' THEN 3
      WHEN 'pwa_order' THEN 2
      WHEN 'main_order' THEN 1
      ELSE 0
    END,
    EXCLUDED.desired_source_id
  ) > (
    job.desired_source_sequence,
    CASE job.desired_source_kind
      WHEN 'card_update' THEN 3
      WHEN 'pwa_order' THEN 2
      WHEN 'main_order' THEN 1
      ELSE 0
    END,
    job.desired_source_id
  )
  OR (
    EXCLUDED.desired_source_kind = job.desired_source_kind
    AND EXCLUDED.desired_source_id = job.desired_source_id
    AND job.status IN ('failed', 'awaiting_token')
  );

  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN v_queued;
END;
$$;

CREATE OR REPLACE FUNCTION public.fence_solidgate_subscription_token_sync_for_tokenless_source(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_source_kind TEXT,
  p_source_created_at TIMESTAMPTZ,
  p_source_sequence BIGINT,
  p_source_id TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source_priority INTEGER := CASE p_source_kind
    WHEN 'card_update' THEN 3
    WHEN 'pwa_order' THEN 2
    WHEN 'main_order' THEN 1
    ELSE 0
  END;
  v_changed INTEGER := 0;
  v_inserted INTEGER := 0;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR p_source_kind NOT IN ('main_order', 'pwa_order')
     OR p_source_created_at IS NULL
     OR p_source_sequence IS NULL
     OR NULLIF(BTRIM(COALESCE(p_source_id, '')), '') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.solidgate_account_vault AS vault
       WHERE vault.payment_environment = p_payment_environment
         AND vault.user_id = p_user_id
         AND vault.card_token IS NULL
         AND vault.card_source_kind = p_source_kind
         AND vault.card_source_created_at = p_source_created_at
         AND vault.card_source_sequence = p_source_sequence
         AND vault.card_source_id = p_source_id
     ) THEN
    RETURN 0;
  END IF;

  UPDATE public.solidgate_subscription_token_sync_jobs AS job
  SET desired_source_kind = p_source_kind,
      desired_source_created_at = p_source_created_at,
      desired_source_sequence = p_source_sequence,
      desired_source_id = p_source_id,
      status = 'awaiting_token',
      claim_token = NULL,
      processing_started_at = NULL,
      next_attempt_at = NOW(),
      applied_at = NULL,
      last_error = NULL,
      updated_at = NOW()
  WHERE job.payment_environment = p_payment_environment
    AND job.user_id = p_user_id
    AND (
      job.desired_source_sequence,
      CASE job.desired_source_kind
        WHEN 'card_update' THEN 3
        WHEN 'pwa_order' THEN 2
        WHEN 'main_order' THEN 1
        ELSE 0
      END,
      job.desired_source_id
    ) <= (
      p_source_sequence,
      v_source_priority,
      p_source_id
    );
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  INSERT INTO public.solidgate_subscription_token_sync_jobs (
    payment_environment,
    user_id,
    solidgate_subscription_id,
    desired_source_kind,
    desired_source_created_at,
    desired_source_sequence,
    desired_source_id,
    status,
    next_attempt_at,
    applied_at,
    last_error,
    updated_at
  )
  SELECT DISTINCT
    p_payment_environment,
    p_user_id,
    entitlement.solidgate_subscription_id,
    p_source_kind,
    p_source_created_at,
    p_source_sequence,
    p_source_id,
    'awaiting_token'::TEXT,
    NOW(),
    NULL::TIMESTAMPTZ,
    NULL::TEXT,
    NOW()
  FROM public.entitlements AS entitlement
  JOIN public.orders AS subscription_order
    ON subscription_order.id = entitlement.order_id
   AND subscription_order.payment_environment = entitlement.payment_environment
   AND subscription_order.user_id = entitlement.user_id
   AND subscription_order.solidgate_subscription_id
         = entitlement.solidgate_subscription_id
   AND subscription_order.product_slug = entitlement.product_slug
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.status IN ('active', 'past_due')
    AND entitlement.revoked_at IS NULL
    AND NULLIF(BTRIM(entitlement.solidgate_subscription_id), '') IS NOT NULL
    AND p_source_sequence > subscription_order.solidgate_card_source_sequence
    AND public.solidgate_subscription_token_sync_is_billable(
      p_payment_environment,
      p_user_id,
      entitlement.solidgate_subscription_id
    )
  ON CONFLICT (payment_environment, user_id, solidgate_subscription_id)
  DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_changed + v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_solidgate_subscription_token_sync(
  p_payment_environment TEXT,
  p_limit INTEGER DEFAULT 10,
  p_lease_seconds INTEGER DEFAULT 300,
  p_user_id UUID DEFAULT NULL
)
RETURNS SETOF public.solidgate_subscription_token_sync_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH candidates AS (
    SELECT job.payment_environment, job.user_id, job.solidgate_subscription_id
    FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE job.payment_environment = p_payment_environment
      AND (p_user_id IS NULL OR job.user_id = p_user_id)
      AND (
        (job.status IN ('pending', 'failed') AND job.next_attempt_at <= NOW())
        OR (
          job.status = 'processing'
          AND job.processing_started_at
                < NOW() - pg_catalog.make_interval(
                    secs => GREATEST(p_lease_seconds, 180)
                  )
        )
      )
    ORDER BY job.next_attempt_at, job.updated_at, job.user_id,
      job.solidgate_subscription_id
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.solidgate_subscription_token_sync_jobs AS job
  SET status = 'processing',
      attempts = job.attempts + 1,
      claim_token = gen_random_uuid(),
      processing_started_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  FROM candidates
  WHERE job.payment_environment = candidates.payment_environment
    AND job.user_id = candidates.user_id
    AND job.solidgate_subscription_id = candidates.solidgate_subscription_id
  RETURNING job.*
$$;

CREATE OR REPLACE FUNCTION public.read_claimed_solidgate_subscription_token_sync(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_subscription_id TEXT,
  p_claim_token UUID
)
RETURNS TABLE (
  desired_source_kind TEXT,
  desired_source_created_at TIMESTAMPTZ,
  desired_source_sequence BIGINT,
  desired_source_id TEXT,
  card_token TEXT,
  subscription_is_billable BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    job.desired_source_kind,
    job.desired_source_created_at,
    job.desired_source_sequence,
    job.desired_source_id,
    vault.card_token,
    public.solidgate_subscription_token_sync_is_billable(
      job.payment_environment,
      job.user_id,
      job.solidgate_subscription_id
    )
  FROM public.solidgate_subscription_token_sync_jobs AS job
  JOIN public.solidgate_account_vault AS vault
    ON vault.payment_environment = job.payment_environment
   AND vault.user_id = job.user_id
   AND vault.card_source_kind = job.desired_source_kind
   AND vault.card_source_created_at = job.desired_source_created_at
   AND vault.card_source_sequence = job.desired_source_sequence
   AND vault.card_source_id = job.desired_source_id
  WHERE job.payment_environment = p_payment_environment
    AND job.user_id = p_user_id
    AND job.solidgate_subscription_id = p_solidgate_subscription_id
    AND job.status = 'processing'
    AND job.claim_token = p_claim_token
    AND NULLIF(BTRIM(vault.card_token), '') IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.complete_solidgate_subscription_token_sync(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_subscription_id TEXT,
  p_claim_token UUID,
  p_desired_source_kind TEXT,
  p_desired_source_id TEXT,
  p_require_nonbillable BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.solidgate_subscription_token_sync_jobs AS job
  SET status = 'applied',
      claim_token = NULL,
      processing_started_at = NULL,
      applied_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  WHERE job.payment_environment = p_payment_environment
    AND job.user_id = p_user_id
    AND job.solidgate_subscription_id = p_solidgate_subscription_id
    AND job.status = 'processing'
    AND job.claim_token = p_claim_token
    AND job.desired_source_kind = p_desired_source_kind
    AND job.desired_source_id = p_desired_source_id
    AND (
      NOT p_require_nonbillable
      OR NOT public.solidgate_subscription_token_sync_is_billable(
        job.payment_environment,
        job.user_id,
        job.solidgate_subscription_id
      )
    )
  RETURNING TRUE
$$;

CREATE OR REPLACE FUNCTION public.fail_solidgate_subscription_token_sync(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_solidgate_subscription_id TEXT,
  p_claim_token UUID,
  p_desired_source_kind TEXT,
  p_desired_source_id TEXT,
  p_last_error TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.solidgate_subscription_token_sync_jobs AS job
  SET status = 'failed',
      claim_token = NULL,
      processing_started_at = NULL,
      next_attempt_at = NOW() + pg_catalog.make_interval(
        secs => LEAST(1800, 5 * (2 ^ LEAST(job.attempts, 8))::INTEGER)
      ),
      last_error = LEFT(COALESCE(p_last_error, 'unknown provider error'), 2000),
      updated_at = NOW()
  WHERE job.payment_environment = p_payment_environment
    AND job.user_id = p_user_id
    AND job.solidgate_subscription_id = p_solidgate_subscription_id
    AND job.status = 'processing'
    AND job.claim_token = p_claim_token
    AND job.desired_source_kind = p_desired_source_kind
    AND job.desired_source_id = p_desired_source_id
  RETURNING TRUE
$$;


-- ── funnel, auth and attribution ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_solidgate_intro_offer(
  p_payment_environment TEXT,
  p_email_hash TEXT,
  p_session_id UUID,
  p_tier TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim public.solidgate_intro_claims%ROWTYPE;
  v_inserted INTEGER := 0;
  v_incumbent_moved_money BOOLEAN;
BEGIN
  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_email_hash IS NULL
     OR p_email_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL
     OR p_tier IS NULL
     OR p_tier NOT IN ('trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free') THEN
    RAISE EXCEPTION 'invalid Solidgate intro-offer claim';
  END IF;

  INSERT INTO public.solidgate_intro_claims (
    payment_environment, email_hash, session_id, tier
  ) VALUES (
    p_payment_environment, p_email_hash, p_session_id, p_tier
  )
  ON CONFLICT (payment_environment, email_hash) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT * INTO STRICT v_claim
  FROM public.solidgate_intro_claims
  WHERE payment_environment = p_payment_environment
    AND email_hash = p_email_hash
  FOR UPDATE;

  IF v_claim.state = 'consumed' THEN
    RETURN 'already_used';
  END IF;

  IF v_claim.session_id = p_session_id AND v_claim.tier = p_tier THEN
    UPDATE public.solidgate_intro_claims
    SET lease_expires_at = NOW() + INTERVAL '60 minutes',
        updated_at = NOW()
    WHERE payment_environment = p_payment_environment
      AND email_hash = p_email_hash;
    RETURN CASE WHEN v_inserted > 0 THEN 'claimed' ELSE 'retry' END;
  END IF;

  -- Anything else is a re-key: a different tier, a different session, or both.
  -- The money question is the ONLY thing that makes a re-key unsafe.
  --
  -- The incumbent blocks when it holds an order that has LEFT 'pending' and
  -- 'failed'. Past those states money moved (or is about to), and re-keying
  -- would let one buyer pay for two subscriptions.
  --
  -- A still-'pending' order with NO live payment status deliberately does NOT
  -- block: create-session writes every checkout as 'pending' before issuing
  -- the intent, so treating it as dangerous would restore the lockout this
  -- ledger kept producing. An abandoned checkout is exactly a 'pending' row
  -- whose payment never started, and it is re-keyable IMMEDIATELY — the lease
  -- is no longer consulted (the pre-2026-07-28 rule made a returning buyer on
  -- a new session wait out a 60-minute lease, which Solidgate's UAT rightly
  -- flagged).
  --
  -- A 'pending' row whose payment DID start (the accepted auth_ok
  -- reservation, a 3DS challenge in flight, or a capture the webhook has not
  -- finalized) blocks like moved money: the card is charged or about to be,
  -- and re-keying would mint a second payable intent for the same email
  -- during the settle window.
  SELECT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.session_id = v_claim.session_id
      AND o.payment_environment = p_payment_environment
      AND (
        o.status NOT IN ('pending', 'failed')
        OR (
          o.status = 'pending'
          AND o.solidgate_payment_status IN (
            'auth_ok', '3ds_verify', 'processing', 'settle_ok', 'partial_settled'
          )
        )
      )
  ) INTO v_incumbent_moved_money;

  IF NOT v_incumbent_moved_money THEN
    UPDATE public.solidgate_intro_claims
    SET session_id = p_session_id,
        tier = p_tier,
        lease_expires_at = NOW() + INTERVAL '60 minutes',
        updated_at = NOW()
    WHERE payment_environment = p_payment_environment
      AND email_hash = p_email_hash;
    RETURN 'claimed';
  END IF;

  RETURN 'in_progress';
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_solidgate_intro_offer(
  p_payment_environment TEXT,
  p_email_hash TEXT,
  p_session_id UUID,
  p_tier TEXT,
  p_subscription_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claim public.solidgate_intro_claims%ROWTYPE;
BEGIN
  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_email_hash IS NULL
     OR p_email_hash !~ '^[0-9a-f]{64}$'
     OR p_session_id IS NULL
     OR p_tier IS NULL
     OR p_tier NOT IN ('trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free')
     OR NULLIF(BTRIM(p_subscription_id), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate intro-offer consumption';
  END IF;

  -- Seed legacy/pre-migration checkout rows without racing grant vs webhook.
  INSERT INTO public.solidgate_intro_claims (
    payment_environment, email_hash, session_id, tier, state,
    solidgate_subscription_id, consumed_at, updated_at
  ) VALUES (
    p_payment_environment, p_email_hash, p_session_id, p_tier, 'consumed',
    p_subscription_id, NOW(), NOW()
  )
  ON CONFLICT (payment_environment, email_hash) DO NOTHING;

  SELECT * INTO STRICT v_claim
  FROM public.solidgate_intro_claims
  WHERE payment_environment = p_payment_environment
    AND email_hash = p_email_hash
  FOR UPDATE;

  IF v_claim.state = 'consumed' THEN
    -- The provider subscription ID is the durable identity, so this stays
    -- idempotent after a GDPR erasure has NULLed session_id.
    IF v_claim.solidgate_subscription_id IS NOT DISTINCT FROM p_subscription_id THEN
      RETURN 'consumed';
    END IF;

    -- A second subscription really was charged to this buyer — the lease was
    -- taken over and an old intent settled anyway, or two tabs raced. We cannot
    -- un-charge it from here, and refusing the grant would leave a paying
    -- customer with nothing, so grant and queue the refund.
    UPDATE public.solidgate_intro_claims
    SET superseded_subscription_ids = CASE
          WHEN p_subscription_id = ANY(superseded_subscription_ids)
            THEN superseded_subscription_ids
          ELSE array_append(superseded_subscription_ids, p_subscription_id)
        END,
        updated_at = NOW()
    WHERE payment_environment = p_payment_environment
      AND email_hash = p_email_hash;
    RETURN 'superseded';
  END IF;

  -- Still pending. Whoever actually paid owns the claim, even if the lease had
  -- been handed to someone else in the meantime: money decides, not the ledger.
  UPDATE public.solidgate_intro_claims
  SET state = 'consumed',
      session_id = p_session_id,
      tier = p_tier,
      solidgate_subscription_id = p_subscription_id,
      consumed_at = COALESCE(consumed_at, NOW()),
      updated_at = NOW()
  WHERE payment_environment = p_payment_environment
    AND email_hash = p_email_hash;

  IF v_claim.session_id IS DISTINCT FROM p_session_id
     OR v_claim.tier IS DISTINCT FROM p_tier THEN
    -- Granted, but the claim was pointed at a different session/tier — a re-key
    -- happened and the displaced intent is the one that settled. Exactly ONE
    -- subscription exists, so this needs NO refund. It is reported separately
    -- from 'superseded' precisely so nobody automates a cancellation off it.
    RETURN 'reassigned';
  END IF;

  RETURN 'consumed';
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_meta_capi_event(
  p_environment TEXT,
  p_event_name TEXT,
  p_event_id TEXT,
  p_ip_hash TEXT,
  p_session_id UUID,
  p_window_seconds INTEGER DEFAULT 600,
  p_max_events INTEGER DEFAULT 40
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recent_count INTEGER;
  v_inserted INTEGER;
BEGIN
  IF p_environment NOT IN ('production', 'preview', 'development')
    OR p_event_name IS NULL OR p_event_name = ''
    OR p_event_id IS NULL OR p_event_id = ''
    OR p_ip_hash IS NULL OR p_ip_hash = ''
    OR p_window_seconds < 1
    OR p_max_events < 1
  THEN
    RETURN FALSE;
  END IF;

  -- Event IDs only need a bounded replay window. Keeping old hashed-IP claims
  -- forever adds no attribution value and would make this ingress ledger grow
  -- without limit.
  DELETE FROM public.meta_capi_event_claims
  WHERE created_at < NOW() - INTERVAL '30 days';

  -- Serialize claims for one IP/environment so parallel requests cannot race
  -- through the count check.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_environment || ':' || p_ip_hash, 0)
  );

  SELECT COUNT(*)::INTEGER
  INTO v_recent_count
  FROM public.meta_capi_event_claims
  WHERE environment = p_environment
    AND ip_hash = p_ip_hash
    AND created_at >= NOW() - make_interval(secs => p_window_seconds);

  IF v_recent_count >= p_max_events THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.meta_capi_event_claims (
    environment,
    event_name,
    event_id,
    ip_hash,
    session_id
  )
  VALUES (
    p_environment,
    p_event_name,
    p_event_id,
    p_ip_hash,
    p_session_id
  )
  ON CONFLICT (environment, event_name, event_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_user_acquisition_attribution(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_source_session_id UUID,
  p_source_order_id UUID,
  p_captured_at TIMESTAMPTZ,
  p_utm_source TEXT DEFAULT NULL,
  p_utm_medium TEXT DEFAULT NULL,
  p_utm_campaign TEXT DEFAULT NULL,
  p_utm_content TEXT DEFAULT NULL,
  p_utm_term TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_changed INTEGER := 0;
BEGIN
  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR p_source_session_id IS NULL
     OR p_source_order_id IS NULL
     OR p_captured_at IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate acquisition attribution';
  END IF;

  IF COALESCE(
    NULLIF(BTRIM(p_utm_source), ''),
    NULLIF(BTRIM(p_utm_medium), ''),
    NULLIF(BTRIM(p_utm_campaign), ''),
    NULLIF(BTRIM(p_utm_content), ''),
    NULLIF(BTRIM(p_utm_term), '')
  ) IS NULL THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.user_acquisition_attribution (
    payment_environment,
    user_id,
    source_session_id,
    source_order_id,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    captured_at
  ) VALUES (
    p_payment_environment,
    p_user_id,
    p_source_session_id,
    p_source_order_id,
    NULLIF(LEFT(BTRIM(p_utm_source), 380), ''),
    NULLIF(LEFT(BTRIM(p_utm_medium), 380), ''),
    NULLIF(LEFT(BTRIM(p_utm_campaign), 380), ''),
    NULLIF(LEFT(BTRIM(p_utm_content), 380), ''),
    NULLIF(LEFT(BTRIM(p_utm_term), 380), ''),
    p_captured_at
  )
  ON CONFLICT (payment_environment, user_id) DO UPDATE
  SET source_session_id = EXCLUDED.source_session_id,
      source_order_id = EXCLUDED.source_order_id,
      utm_source = EXCLUDED.utm_source,
      utm_medium = EXCLUDED.utm_medium,
      utm_campaign = EXCLUDED.utm_campaign,
      utm_content = EXCLUDED.utm_content,
      utm_term = EXCLUDED.utm_term,
      captured_at = EXCLUDED.captured_at,
      updated_at = NOW()
  WHERE EXCLUDED.captured_at < public.user_acquisition_attribution.captured_at;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed > 0;
END;
$$;

create or replace function public.find_auth_user_id_by_email(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_user_id uuid;
  v_match_count integer;
begin
  if p_email is null or trim(p_email) = '' then
    return null;
  end if;

  select candidate.id, candidate.match_count
  into v_user_id, v_match_count
  from (
    select id, count(*) over ()::integer as match_count
    from auth.users
    where instance_id = '00000000-0000-0000-0000-000000000000'::uuid
      and lower(email) = lower(trim(p_email))
    order by created_at asc, id asc
  ) as candidate
  limit 1;

  if coalesce(v_match_count, 0) > 1 then
    -- SSO can create more than one auth user with the same email. Silently
    -- choosing either account could grant paid access to the wrong identity.
    raise exception 'ambiguous auth user email'
      using errcode = 'P0001';
  end if;

  return v_user_id;
end;
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_auth_sessions(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sessions INTEGER := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid user id for session revocation';
  END IF;

  -- refresh_tokens.user_id is VARCHAR in GoTrue's schema, sessions.user_id is
  -- UUID. Deleting sessions cascades to their refresh tokens; the explicit
  -- refresh-token delete also covers legacy rows with no session binding.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::TEXT;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  RETURN v_sessions;
END;
$$;


-- ── member-area activity ────────────────────────────────────────────────────

-- Records an app open and lazily creates the prefs row. Returns the new counter
-- so the client can drive first-run / nth-run experiences without a second
-- round trip.
CREATE OR REPLACE FUNCTION public.bump_user_app_open(
  p_user_id        UUID,
  p_default_locale TEXT
)
RETURNS TABLE (
  app_open_count INTEGER,
  last_active_at TIMESTAMPTZ
)
LANGUAGE sql
AS $$
  INSERT INTO public.user_prefs (user_id, locale, app_open_count, last_active_at)
  VALUES (p_user_id, p_default_locale, 1, now())
  ON CONFLICT (user_id) DO UPDATE
    SET app_open_count = public.user_prefs.app_open_count + 1,
        last_active_at = now()
  RETURNING public.user_prefs.app_open_count,
            public.user_prefs.last_active_at;
$$;
-- ═════════════════════════════════════════════════════════════════════════════
-- 8. TRIGGERS
--
-- None of these functions is reachable via .rpc(); a "find unused functions"
-- grep will report every one of them as dead. They are not. They enforce the
-- money invariants: payable-order uniqueness, immutable checkout identity,
-- entitlement replay prevention, and monotonic vault card sources. Deleting
-- one removes a payment safety net while every application-level test still
-- passes.
-- ═════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS orders_updated_at_trigger ON public.orders;
CREATE TRIGGER orders_updated_at_trigger
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_orders_updated_at();

DROP TRIGGER IF EXISTS guard_solidgate_checkout_identity_trigger ON public.orders;
CREATE TRIGGER guard_solidgate_checkout_identity_trigger
  BEFORE INSERT OR UPDATE OF
    psp,
    solidgate_customer_email,
    solidgate_checkout_locale,
    solidgate_product_id,
    solidgate_payment_action,
    solidgate_checkout_identity_bound_at,
    solidgate_checkout_identity_legacy
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_checkout_identity();

DROP TRIGGER IF EXISTS guard_solidgate_main_payable_order_trigger ON public.orders;
CREATE TRIGGER guard_solidgate_main_payable_order_trigger
  BEFORE INSERT OR UPDATE OF
    status,
    amount_cents,
    currency,
    created_at,
    payment_environment,
    session_id,
    psp,
    product_name,
    product_slug,
    solidgate_order_id,
    solidgate_original_amount_cents,
    solidgate_payment_status,
    solidgate_refunded_amount_cents,
    solidgate_chargeback_id,
    solidgate_chargeback_status,
    solidgate_chargeback_amount_cents,
    tracking_metadata
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_main_payable_order();

DROP TRIGGER IF EXISTS guard_solidgate_oto_payable_order_trigger ON public.orders;
CREATE TRIGGER guard_solidgate_oto_payable_order_trigger
  BEFORE INSERT OR UPDATE OF
    status,
    amount_cents,
    solidgate_payment_status,
    payment_environment,
    session_id,
    psp,
    product_name,
    product_slug,
    solidgate_order_id,
    solidgate_original_amount_cents,
    currency,
    tracking_metadata,
    solidgate_customer_email,
    solidgate_checkout_locale,
    solidgate_checkout_identity_bound_at,
    solidgate_checkout_identity_legacy,
    solidgate_product_id,
    solidgate_payment_action
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_oto_payable_order();

DROP TRIGGER IF EXISTS guard_solidgate_pwa_payable_order_trigger ON public.orders;
CREATE TRIGGER guard_solidgate_pwa_payable_order_trigger
  BEFORE INSERT OR UPDATE OF
    status,
    amount_cents,
    currency,
    solidgate_original_amount_cents,
    solidgate_payment_status,
    payment_environment,
    session_id,
    user_id,
    psp,
    product_name,
    product_slug,
    solidgate_order_id,
    tracking_metadata
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_pwa_payable_order();

DROP TRIGGER IF EXISTS prevent_solidgate_entitlement_replay ON public.entitlements;
CREATE TRIGGER prevent_solidgate_entitlement_replay
  BEFORE INSERT OR UPDATE OF
    status,
    revoked_at,
    order_id,
    payment_environment,
    user_id,
    product_slug,
    solidgate_subscription_id
  ON public.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_solidgate_entitlement_replay();

DROP TRIGGER IF EXISTS solidgate_subscription_token_sync_entitlement_trigger
  ON public.entitlements;
CREATE TRIGGER solidgate_subscription_token_sync_entitlement_trigger
  AFTER INSERT OR UPDATE OF
    payment_environment,
    user_id,
    order_id,
    solidgate_subscription_id,
    status,
    revoked_at
  ON public.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_solidgate_subscription_token_sync_from_entitlement();

-- Vault guards are split insert/update because the UPDATE variant must list the
-- exact columns that may move a card source; a blanket BEFORE UPDATE would fire
-- on unrelated bookkeeping writes and reject them.
DROP TRIGGER IF EXISTS guard_solidgate_session_vault_card_source_insert_trigger
  ON public.solidgate_session_vault;
CREATE TRIGGER guard_solidgate_session_vault_card_source_insert_trigger
  BEFORE INSERT ON public.solidgate_session_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_session_vault_card_source();

DROP TRIGGER IF EXISTS guard_solidgate_session_vault_card_source_update_trigger
  ON public.solidgate_session_vault;
CREATE TRIGGER guard_solidgate_session_vault_card_source_update_trigger
  BEFORE UPDATE OF
    customer_account_id,
    card_token,
    card_brand,
    card_last4,
    card_source_order_id,
    card_source_created_at,
    card_source_sequence,
    card_source_legacy
  ON public.solidgate_session_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_session_vault_card_source();

DROP TRIGGER IF EXISTS guard_solidgate_session_vault_payment_method_insert_trigger
  ON public.solidgate_session_vault;
CREATE TRIGGER guard_solidgate_session_vault_payment_method_insert_trigger
  BEFORE INSERT ON public.solidgate_session_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_session_vault_payment_method();

DROP TRIGGER IF EXISTS guard_solidgate_session_vault_payment_method_update_trigger
  ON public.solidgate_session_vault;
CREATE TRIGGER guard_solidgate_session_vault_payment_method_update_trigger
  BEFORE UPDATE OF
    card_original_payment_method,
    card_source_order_id,
    card_source_created_at,
    card_source_sequence,
    card_source_legacy
  ON public.solidgate_session_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_session_vault_payment_method();

DROP TRIGGER IF EXISTS guard_solidgate_account_vault_card_source_insert_trigger
  ON public.solidgate_account_vault;
CREATE TRIGGER guard_solidgate_account_vault_card_source_insert_trigger
  BEFORE INSERT ON public.solidgate_account_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_account_vault_card_source();

DROP TRIGGER IF EXISTS guard_solidgate_account_vault_card_source_update_trigger
  ON public.solidgate_account_vault;
CREATE TRIGGER guard_solidgate_account_vault_card_source_update_trigger
  BEFORE UPDATE OF
    card_token,
    card_brand,
    card_last4,
    card_source_kind,
    card_source_created_at,
    card_source_sequence,
    card_source_id
  ON public.solidgate_account_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_account_vault_card_source();

DROP TRIGGER IF EXISTS guard_solidgate_account_vault_payment_method_insert_trigger
  ON public.solidgate_account_vault;
CREATE TRIGGER guard_solidgate_account_vault_payment_method_insert_trigger
  BEFORE INSERT ON public.solidgate_account_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_account_vault_payment_method();

DROP TRIGGER IF EXISTS guard_solidgate_account_vault_payment_method_update_trigger
  ON public.solidgate_account_vault;
CREATE TRIGGER guard_solidgate_account_vault_payment_method_update_trigger
  BEFORE UPDATE OF
    card_original_payment_method,
    card_source_kind,
    card_source_created_at,
    card_source_sequence,
    card_source_id
  ON public.solidgate_account_vault
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_solidgate_account_vault_payment_method();


-- ════════════════════════════════════════════════════════════════════════════
-- 9. FUNCTION PRIVILEGES
-- Default-deny everything, then hand service_role exactly the RPCs the
-- application calls. Functions marked internal are reachable only from
-- inside another SECURITY DEFINER function or from a trigger, so even
-- service_role cannot call them directly.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.solidgate_oto_step_from_product_slug(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solidgate_oto_step_from_product_slug(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.solidgate_oto_step_from_internal_slug(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solidgate_oto_step_from_internal_slug(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.solidgate_persisted_oto_step(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solidgate_persisted_oto_step(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.solidgate_pwa_product_code(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solidgate_pwa_product_code(TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.solidgate_main_checkout_amount(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solidgate_main_checkout_amount(TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.bump_orders_updated_at()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_checkout_identity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_main_payable_order()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_oto_payable_order()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_pwa_payable_order()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_session_vault_card_source()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_session_vault_payment_method()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_account_vault_card_source()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_solidgate_account_vault_payment_method()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_solidgate_entitlement_replay()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_solidgate_entitlement_replay() TO service_role;
REVOKE ALL ON FUNCTION public.enqueue_solidgate_subscription_token_sync_from_entitlement()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_solidgate_webhook_event(TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_webhook_event(TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_webhook_event_v2(TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_webhook_event_v2(TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.complete_solidgate_webhook_event_v2(TEXT, TEXT, UUID, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_solidgate_webhook_event_v2(TEXT, TEXT, UUID, BIGINT) TO service_role;
REVOKE ALL ON FUNCTION public.fail_solidgate_webhook_event_v2(TEXT, TEXT, UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_solidgate_webhook_event_v2(TEXT, TEXT, UUID, BIGINT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_entity_event(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_entity_event(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.complete_solidgate_entity_event(TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_solidgate_entity_event(TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.release_solidgate_entity_event(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_solidgate_entity_event(TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_analytics_outbox(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_analytics_outbox(TEXT, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_fulfillment_outbox(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_fulfillment_outbox(TEXT, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.solidgate_checkout_core_is_canonical(public.orders)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_solidgate_main_checkout_identity(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solidgate_main_checkout_identity(TEXT, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.get_solidgate_pwa_checkout_identity(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solidgate_pwa_checkout_identity(TEXT, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.open_solidgate_main_checkout(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB, UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.open_solidgate_main_checkout_v2(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB, UUID, TEXT, TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_solidgate_main_checkout_v2(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_solidgate_main_checkout(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_solidgate_main_checkout_v2(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_solidgate_main_checkout_v2(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, JSONB, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.open_solidgate_oto_order_v2(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_solidgate_oto_order_v2(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.resume_solidgate_oto_order_after_absent_reconcile(TEXT, UUID, TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_solidgate_oto_order_after_absent_reconcile(TEXT, UUID, TEXT, UUID, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.open_solidgate_pwa_purchase(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.open_solidgate_pwa_purchase_v2(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_solidgate_pwa_purchase_v2(TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_solidgate_pwa_form(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_solidgate_pwa_form_v2(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_solidgate_pwa_form_v2(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, JSONB, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.record_solidgate_pwa_submission_result(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_solidgate_pwa_submission_result(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.resume_solidgate_pwa_submission_after_absent_reconcile(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_solidgate_pwa_submission_after_absent_reconcile(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.record_solidgate_pwa_confirmed_capture(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_solidgate_pwa_confirmed_capture(TEXT, UUID, TEXT, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.advance_solidgate_oto_progress(TEXT, UUID, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_solidgate_oto_progress(TEXT, UUID, INTEGER, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_solidgate_legacy_order_identity(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.solidgate_special_free_card_ready(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.solidgate_special_free_card_ready(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.grant_solidgate_main_entitlement(TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_solidgate_main_entitlement(TEXT, UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.grant_solidgate_oto_entitlement(TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_solidgate_oto_entitlement(TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.grant_solidgate_pwa_entitlement(TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_solidgate_pwa_entitlement(TEXT, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.apply_solidgate_subscription_entitlement_lifecycle(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_solidgate_subscription_entitlement_lifecycle(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.write_solidgate_session_vault_monotonic(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_solidgate_session_vault_monotonic(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.write_solidgate_account_vault_monotonic(TEXT, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_solidgate_account_vault_monotonic(TEXT, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.promote_solidgate_session_vault_monotonic(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_solidgate_session_vault_monotonic(TEXT, UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.write_solidgate_session_vault_with_method(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_solidgate_session_vault_with_method(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.write_solidgate_account_vault_with_method(TEXT, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_solidgate_account_vault_with_method(TEXT, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.promote_solidgate_session_vault_with_method(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_solidgate_session_vault_with_method(TEXT, UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.clear_solidgate_legacy_session_vault(TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.open_solidgate_card_update_attempt(TEXT, UUID, TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_solidgate_card_update_attempt(TEXT, UUID, TEXT, TEXT, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_solidgate_card_update_attempt(TEXT, UUID, UUID, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_solidgate_card_update_attempt(TEXT, UUID, UUID, TEXT, UUID, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_card_update_attempt(TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_card_update_attempt(TEXT, UUID, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.get_solidgate_card_update_attempt(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_solidgate_card_update_attempt(TEXT, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.release_solidgate_card_update_attempt(TEXT, UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_solidgate_card_update_attempt(TEXT, UUID, TEXT, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.complete_solidgate_card_update_attempt(TEXT, UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_solidgate_card_update_attempt(TEXT, UUID, TEXT, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.record_solidgate_card_update_attempt_status(TEXT, UUID, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_solidgate_card_update_attempt_status(TEXT, UUID, TEXT, TEXT, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION public.solidgate_subscription_token_sync_is_billable(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_solidgate_subscription_token_sync(TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fence_solidgate_subscription_token_sync_for_tokenless_source(TEXT, UUID, TEXT, TIMESTAMPTZ, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_subscription_token_sync(TEXT, INTEGER, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_subscription_token_sync(TEXT, INTEGER, INTEGER, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.read_claimed_solidgate_subscription_token_sync(TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_claimed_solidgate_subscription_token_sync(TEXT, UUID, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.complete_solidgate_subscription_token_sync(TEXT, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_solidgate_subscription_token_sync(TEXT, UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION public.fail_solidgate_subscription_token_sync(TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_solidgate_subscription_token_sync(TEXT, UUID, TEXT, UUID, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.claim_solidgate_intro_offer(TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_solidgate_intro_offer(TEXT, TEXT, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.consume_solidgate_intro_offer(TEXT, TEXT, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_solidgate_intro_offer(TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.claim_meta_capi_event(TEXT, TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_meta_capi_event(TEXT, TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.persist_user_acquisition_attribution(TEXT, UUID, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_user_acquisition_attribution(TEXT, UUID, UUID, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.find_auth_user_id_by_email(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_auth_user_id_by_email(text) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_user_auth_sessions(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_auth_sessions(UUID) TO service_role;
