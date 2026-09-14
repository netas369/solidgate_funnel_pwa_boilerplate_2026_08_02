-- CRO dashboard read API — authorization and aggregate behaviour.
--
-- A separate script from quiz_backend.sql because it needs a POPULATION rather
-- than one narrative session: two quiz variants, two funnel variants, two
-- locales, two devices, a session with empty step_activity, and one inside the
-- settle window. It also needs `auth.jwt()`, which the harness in README.md now
-- stubs — DDL is transactional, so nothing here survives the ROLLBACK.
--
-- These functions are the ONLY way apps/cro reads anything: it holds the anon
-- key and no service-role key. So the authorization half below is not a nicety,
-- it is the entire security boundary.

\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO public.cro_analysts (email, note)
VALUES ('cro-fixture@example.test', 'cro_dashboard fixture')
ON CONFLICT (email) DO NOTHING;

SELECT public.publish_quiz_definition(
  'cro-v1', 'croapp', 'main', 'q1', 4, repeat('c', 64),
  '[{"step_id":"q1","position":1,"sort_index":1,"step_type":"radio",
     "is_question":true,"is_terminal":false,"answer_keys":["goal"],
     "option_values":["lose","gain"],"store_as":"goal","label":"Your goal?",
     "is_unconditional":true,"entry_skippable":false,
     "next":[{"to_step_id":"q2","on_value":null}]},
    {"step_id":"q2","position":2,"sort_index":2,"step_type":"multi_select",
     "is_question":true,"is_terminal":false,"answer_keys":["chal"],
     "option_values":["o1","o2","o3"],"store_as":"chal","label":"Challenges?",
     "is_unconditional":true,"entry_skippable":false,
     "next":[{"to_step_id":"q3","on_value":null}]},
    {"step_id":"q3","position":3,"sort_index":3,"step_type":"email_capture",
     "is_question":true,"is_terminal":false,"answer_keys":["email"],
     "option_values":[],"store_as":"email","label":"Your email",
     "is_unconditional":true,"entry_skippable":false,
     "next":[{"to_step_id":"q4","on_value":null}]},
    {"step_id":"q4","position":4,"sort_index":4,"step_type":"loading_screen",
     "is_question":false,"is_terminal":true,"answer_keys":[],
     "option_values":[],"label":"Building","is_unconditional":true,
     "entry_skippable":false,"next":[]}]'::JSONB
);

INSERT INTO public.sessions
  (id, locale, quiz_variant, funnel_variant, source, status,
   created_at, updated_at, client_context, quiz_answers, step_activity, email)
VALUES
  -- Answered q1 and q2, stopped on q3. Carries a real address in quiz_answers:
  -- the PII assertion below depends on it being there and NOT coming back out.
  ('e0000000-0000-4000-8000-000000000001','en','cro-v1','main-v1','quiz','active',
   now() - INTERVAL '3 hours', now() - INTERVAL '3 hours',
   '{"device_type":"mobile","country":"LT","browser":"Safari","ip_address":"203.0.113.9","city":"Vilnius"}'::JSONB,
   '{"goal":"lose","chal":["o1","o3"],"email":"buyer@example.test","strayKey":"undeclared"}'::JSONB,
   '{"q1":{"viewed_at":"2026-09-14T09:00:00Z","answered_at":"2026-09-14T09:00:10Z","skipped":false,"views":1},
     "q2":{"viewed_at":"2026-09-14T09:00:10Z","answered_at":"2026-09-14T09:00:40Z","skipped":false,"views":1},
     "q3":{"viewed_at":"2026-09-14T09:00:40Z","answered_at":null,"skipped":false,"views":1}}'::JSONB,
   'buyer@example.test'),
  -- Desktop, another market, answered q1 only.
  ('e0000000-0000-4000-8000-000000000002','lt','cro-v1','main-v1','quiz','active',
   now() - INTERVAL '3 hours', now() - INTERVAL '3 hours',
   '{"device_type":"desktop","country":"DE","browser":"Chrome"}'::JSONB,
   '{"goal":"gain"}'::JSONB,
   '{"q1":{"viewed_at":"2026-09-14T08:00:00Z","answered_at":"2026-09-14T08:00:05Z","skipped":false,"views":2}}'::JSONB,
   NULL),
  -- Landed and bounced: no step_activity, no current_step_id, and RECENT so it
  -- is inside both the live window and the settle window.
  ('e0000000-0000-4000-8000-000000000003','en','cro-v1','main-v1','quiz','active',
   now() - INTERVAL '4 minutes', now() - INTERVAL '4 minutes',
   '{"device_type":"mobile"}'::JSONB, '{}'::JSONB, '{}'::JSONB, NULL);

-- ── Authorization ───────────────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"stranger@example.test"}', true);

  -- Every read function must refuse a non-analyst, and refuse with 42501
  -- specifically: apps/cro branches on the SQLSTATE to render "ask for access"
  -- instead of a board that merely looks like a quiet day.
  BEGIN
    PERFORM * FROM public.cro_step_funnel(now() - INTERVAL '1 day', now());
    RAISE EXCEPTION 'cro_step_funnel answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM * FROM public.cro_funnel_segments(now() - INTERVAL '1 day', now());
    RAISE EXCEPTION 'cro_funnel_segments answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM * FROM public.cro_quiz_catalog('cro-v1');
    RAISE EXCEPTION 'cro_quiz_catalog answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM * FROM public.cro_session_totals(now() - INTERVAL '1 day', now());
    RAISE EXCEPTION 'cro_session_totals answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM * FROM public.cro_live_sessions(15);
    RAISE EXCEPTION 'cro_live_sessions answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM * FROM public.cro_answer_distribution(now() - INTERVAL '1 day', now(), 'cro-v1');
    RAISE EXCEPTION 'cro_answer_distribution answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM * FROM public.cro_segment_breakdown(now() - INTERVAL '1 day', now());
    RAISE EXCEPTION 'cro_segment_breakdown answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- A JWT with no email claim at all must not pass. is_cro_analyst() compares
  -- against COALESCE(..., ''), so this is what the email-shape CHECK on
  -- cro_analysts protects: one empty-string row would otherwise admit everyone.
  PERFORM set_config('request.jwt.claims', '{}', true);
  ASSERT NOT public.is_cro_analyst(), 'a JWT with no email claim was admitted';
END;
$$;

DO $$
BEGIN
  -- An empty address must be impossible to store in the first place.
  BEGIN
    INSERT INTO public.cro_analysts (email) VALUES ('');
    RAISE EXCEPTION 'cro_analysts accepted an empty email';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Mixed case on the claim against a lowercase row: is_cro_analyst() lowers
  -- both sides. Without that, every analyst whose mail client capitalises their
  -- address is locked out.
  PERFORM set_config('request.jwt.claims', '{"email":"CRO-Fixture@Example.TEST"}', true);
  ASSERT public.is_cro_analyst(), 'mixed-case claim did not match a lowercase row';
END;
$$;

-- The premise the whole anon-key posture rests on: a valid analyst must not be
-- able to go AROUND the functions to the underlying rows. Pinned here because
-- it is the justification for apps/cro holding no service-role key.
DO $$
DECLARE n INTEGER;
BEGIN
  SET LOCAL ROLE authenticated;

  BEGIN
    EXECUTE 'SELECT count(*) FROM public.quiz_definition_steps' INTO n;
    RAISE EXCEPTION 'the catalog was readable directly by authenticated';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    EXECUTE 'SELECT count(*) FROM public.cro_analysts' INTO n;
    RAISE EXCEPTION 'an analyst could enumerate colleagues';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- sessions is reachable but RLS-scoped to auth.uid(), which is NULL here.
  EXECUTE 'SELECT count(*) FROM public.sessions' INTO n;
  ASSERT n = 0, format('authenticated saw %s session rows; RLS should show none', n);

  RESET ROLE;
END;
$$;

-- Every cro_* function must be executable by authenticated and closed to anon.
-- The two OTP helpers are the deliberate exception: login happens before there
-- is a session. This loop is what catches a function added later whose REVOKE
-- was forgotten.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname, p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'cro\_%' OR p.proname = 'is_cro_analyst')
  LOOP
    ASSERT has_function_privilege('authenticated', r.oid, 'EXECUTE'),
      format('%s is not executable by authenticated', r.proname);

    IF r.proname IN ('cro_check_otp_rate_limit', 'cro_record_otp_attempt') THEN
      ASSERT has_function_privilege('anon', r.oid, 'EXECUTE'),
        format('%s must stay reachable for the login form', r.proname);
    ELSE
      ASSERT NOT has_function_privilege('anon', r.oid, 'EXECUTE'),
        format('%s is EXECUTABLE BY ANON — a REVOKE was forgotten', r.proname);
    END IF;
  END LOOP;
END;
$$;

-- No read function may expose a PII column by name. Cheap, and it fails the day
-- someone widens a RETURNS TABLE without thinking.
DO $$
DECLARE r RECORD; sig TEXT;
BEGIN
  FOR r IN
    SELECT p.proname, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'cro\_%'
  LOOP
    sig := COALESCE(pg_get_function_result(r.oid), '');
    ASSERT sig !~* '\m(ip_address|user_agent|city|visitor_id|session_id)\M',
      format('%s exposes a PII column: %s', r.proname, sig);
    -- `email` appears only as an ANSWER KEY value, never as an output column.
    ASSERT sig !~* '\memail\M', format('%s exposes an email column', r.proname);
  END LOOP;
END;
$$;

-- ── Aggregate behaviour, as a real analyst ──────────────────────────────────

SELECT set_config('request.jwt.claims', '{"email":"cro-fixture@example.test"}', true);

DO $$
DECLARE r RECORD;
BEGIN
  -- A session with no step_activity counts as a START but contributes nothing
  -- to the funnel. Both halves asserted together: the pairing IS the point,
  -- because cro_step_funnel alone silently undercounts entries.
  SELECT * INTO r FROM public.cro_session_totals(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1');
  ASSERT r.sessions = 3,      format('expected 3 sessions, got %s', r.sessions);
  ASSERT r.with_activity = 2, format('expected 2 with activity, got %s', r.with_activity);
  ASSERT r.no_activity = 1,   format('expected 1 with none, got %s', r.no_activity);
  -- A COUNT of captured leads, never the addresses.
  ASSERT r.lead_captured = 1, format('expected 1 lead, got %s', r.lead_captured);

  ASSERT (
    SELECT COALESCE(sum(viewed), 0) FROM public.cro_step_funnel(
      now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1')
    WHERE step_id = 'q4'
  ) = 0, 'a step nobody reached reported views';
END;
$$;

DO $$
DECLARE r RECORD;
BEGIN
  -- The landing cohort. create_quiz_session never sets current_step_id, so a
  -- live board keyed on it alone drops every visitor who arrived and left —
  -- the largest bucket, and the one with the worst drop-off.
  SELECT * INTO r FROM public.cro_live_sessions(30, 'cro-v1') WHERE step_id = 'q1';
  ASSERT FOUND, 'the landing cohort is missing from the live board';
  ASSERT r.step_basis = 'landing',
    format('expected step_basis landing, got %s', r.step_basis);
  ASSERT r.label = 'Your goal?', 'the live board did not resolve a label';

  -- The window is bounded so an auto-refreshing tab cannot seq-scan sessions.
  BEGIN
    PERFORM * FROM public.cro_live_sessions(0);
    RAISE EXCEPTION 'cro_live_sessions accepted a zero window';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.cro_live_sessions(1000);
    RAISE EXCEPTION 'cro_live_sessions accepted a 1000-minute window';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;
$$;

DO $$
DECLARE n INTEGER; r RECORD;
BEGIN
  -- Blending versions blends answer vocabularies under one key name, so the
  -- variant is required rather than defaulted.
  BEGIN
    PERFORM * FROM public.cro_answer_distribution(
      now() - INTERVAL '1 day', now(), NULL);
    RAISE EXCEPTION 'cro_answer_distribution accepted a NULL quiz_variant';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  -- ["o1","o3"] is TWO value rows but ONE answered session. Getting that
  -- denominator wrong is the easiest way to publish percentages over 100.
  SELECT count(*) INTO n FROM public.cro_answer_distribution(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1', 'q2');
  ASSERT n = 2, format('expected 2 multi-select rows, got %s', n);

  SELECT * INTO r FROM public.cro_answer_distribution(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1', 'q2')
  WHERE answer_value = 'o1';
  ASSERT r.sessions = 1, format('expected 1 session for o1, got %s', r.sessions);
  ASSERT r.answered_sessions = 1,
    format('answered_sessions must count the KEY once, got %s', r.answered_sessions);
  ASSERT r.in_option_set, 'o1 is a declared option and should be flagged as one';

  -- A scalar must come back unquoted. `::text` on a jsonb string keeps the
  -- quotes and every label in the chart renders as "lose" rather than lose.
  SELECT * INTO r FROM public.cro_answer_distribution(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1', 'q1')
  WHERE answer_value = 'lose';
  ASSERT FOUND, 'a scalar answer came back quoted or not at all';

  -- THE PII ASSERTION, stated positively. The fixture session holds
  -- buyer@example.test under a DECLARED answer key, and it must not come out.
  SELECT * INTO r FROM public.cro_answer_distribution(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1', 'q3');
  ASSERT r.value_kind = 'freeform',
    format('email_capture must be freeform, got %s', r.value_kind);
  ASSERT r.answer_value IS NULL, 'an email address was published as an answer value';
  ASSERT r.sessions = 1, 'the email gate lost its completion count';

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.cro_answer_distribution(
      now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1')
    WHERE answer_value LIKE '%@%'
  ), 'an address-shaped value escaped the allowlist';

  -- An undeclared key in quiz_answers is invisible, not wrong: the function is
  -- driven from the catalog, never from jsonb_object_keys(quiz_answers).
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.cro_answer_distribution(
      now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1')
    WHERE answer_key = 'strayKey'
  ), 'an undeclared answer key was reported';
END;
$$;

DO $$
DECLARE r RECORD;
BEGIN
  -- A session with empty step_activity must survive with max_position 0 rather
  -- than vanishing. That is the difference between "37% never got past the
  -- landing" and "that segment has no data".
  SELECT * INTO r FROM public.cro_segment_breakdown(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1',
    NULL, NULL, 'device') WHERE bucket = 'mobile';
  ASSERT r.sessions = 2, format('expected 2 mobile sessions, got %s', r.sessions);
  ASSERT r.with_activity = 1, 'the bounced mobile session was dropped';
  -- Two mobile sessions reaching positions 0 and 3 have a true median of 1.5.
  -- carnivore-app casts this to INTEGER and reports 1, losing 14% of a
  -- seven-step funnel to a silent truncation.
  ASSERT r.median_max_position = 1.5,
    format('expected an interpolated median of 1.5, got %s', r.median_max_position);

  -- A missing client_context key buckets as 'unknown' rather than dropping the
  -- row: country is null on any deployment not behind Vercel or Cloudflare.
  SELECT * INTO r FROM public.cro_segment_breakdown(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour', 'cro-v1',
    NULL, NULL, 'country') WHERE bucket = 'unknown';
  ASSERT FOUND, 'a session with no country was dropped instead of bucketed';

  BEGIN
    PERFORM * FROM public.cro_segment_breakdown(
      now() - INTERVAL '1 day', now(), NULL, NULL, NULL, 'ip_address');
    RAISE EXCEPTION 'cro_segment_breakdown accepted an unlisted dimension';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;
$$;

DO $$
DECLARE n INTEGER;
BEGIN
  -- The pickers must offer device and country, and must NOT be filtered by the
  -- current selection: it is the escape hatch from a filter that selected an
  -- empty window.
  SELECT count(DISTINCT kind) INTO n FROM public.cro_funnel_segments(
    now() - INTERVAL '1 day', now() + INTERVAL '1 hour');
  ASSERT n >= 5, format('expected at least 5 segment kinds, got %s', n);

  ASSERT EXISTS (
    SELECT 1 FROM public.cro_funnel_segments(
      now() - INTERVAL '1 day', now() + INTERVAL '1 hour')
    WHERE kind = 'device' AND id = 'mobile'
  ), 'the device picker has no options';

  -- The catalog is readable through the function even though the table is not.
  SELECT count(*) INTO n FROM public.cro_quiz_catalog('cro-v1');
  ASSERT n = 4, format('expected 4 catalog steps, got %s', n);
END;
$$;

ROLLBACK;

\echo 'cro_dashboard PASSED'
