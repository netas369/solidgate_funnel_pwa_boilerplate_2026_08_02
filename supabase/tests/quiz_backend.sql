\set ON_ERROR_STOP on

BEGIN;

SELECT public.create_quiz_session(
  '10000000-0000-4000-8000-000000000001'::UUID,
  NULL,
  'visitor-1',
  'boilerplate-v1',
  'main-v1',
  'en',
  'quiz',
  '{"utm_source":"test"}'::JSONB,
  '{"device_type":"desktop"}'::JSONB,
  '20000000-0000-4000-8000-000000000001'::UUID
);

DO $$
BEGIN
  ASSERT (
    SELECT count(*) = 1
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'quiz creation must create exactly one sessions row';
  ASSERT (
    SELECT count(*) = 1
    FROM public.funnel_events
    WHERE session_id = '10000000-0000-4000-8000-000000000001'::UUID
      AND event_type = 'quiz_started'
  ), 'quiz creation must atomically create quiz_started';
END;
$$;

SELECT public.save_quiz_session_progress(
  '10000000-0000-4000-8000-000000000001'::UUID,
  0,
  '{"gender":"female","primaryGoal":"a"}'::JSONB,
  'step2',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '20000000-0000-4000-8000-000000000002'::UUID,
  'step_completed',
  1,
  '{"step_id":"step1"}'::JSONB
);

DO $$
BEGIN
  ASSERT (
    SELECT count(*) = 1
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'progress saves must not create answer rows or extra sessions';
  ASSERT (
    SELECT revision = 1
      AND quiz_answers = '{"gender":"female","primaryGoal":"a"}'::JSONB
      AND current_step_id = 'step2'
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'save must replace current JSONB state and advance revision';
  ASSERT (
    SELECT count(*) = 1
    FROM public.funnel_events
    WHERE session_id = '10000000-0000-4000-8000-000000000001'::UUID
      AND event_type = 'step_completed'
      AND step_number = 1
  ), 'progress and step milestone must commit together';
END;
$$;

-- Simulate nine more question saves. Each call replaces the complete JSONB
-- answer state on the same session; it must never create an answer row.
DO $$
DECLARE
  v_revision INTEGER;
  v_answers JSONB := '{"gender":"female","primaryGoal":"a"}'::JSONB;
BEGIN
  FOR v_revision IN 1..9 LOOP
    v_answers := v_answers || jsonb_build_object(
      'answer_' || v_revision::TEXT,
      'value_' || v_revision::TEXT
    );
    PERFORM public.save_quiz_session_progress(
      '10000000-0000-4000-8000-000000000001'::UUID,
      v_revision,
      v_answers,
      'step' || (v_revision + 2)::TEXT,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      '{}'::JSONB
    );
  END LOOP;

  ASSERT (
    SELECT count(*) = 1
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'ten question saves must still leave exactly one sessions row';
  ASSERT (
    SELECT revision = 10
      AND quiz_answers->>'gender' = 'female'
      AND quiz_answers->>'answer_9' = 'value_9'
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'the one session row must hold the latest complete answer state';
  ASSERT NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('quiz_responses', 'quiz_results', 'funnel_inputs')
  ), 'standard quiz persistence must not add per-answer/result/input tables';
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.save_quiz_session_progress(
      '10000000-0000-4000-8000-000000000001'::UUID,
      0,
      '{}'::JSONB,
      'step1',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      '{}'::JSONB
    );
    RAISE EXCEPTION 'stale revision unexpectedly succeeded';
  EXCEPTION
    WHEN serialization_failure THEN
      ASSERT SQLERRM = 'QUIZ_STALE_REVISION:10';
  END;

  ASSERT (
    SELECT revision = 10
      AND quiz_answers->>'gender' = 'female'
      AND quiz_answers->>'answer_9' = 'value_9'
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'stale writes must not replace newer answers';
END;
$$;

SELECT public.record_funnel_event(
  '20000000-0000-4000-8000-000000000003'::UUID,
  '10000000-0000-4000-8000-000000000001'::UUID,
  'offer_viewed',
  NULL,
  '{"offer_code":"main"}'::JSONB,
  now()
);
SELECT public.record_funnel_event(
  '20000000-0000-4000-8000-000000000003'::UUID,
  '10000000-0000-4000-8000-000000000001'::UUID,
  'offer_viewed',
  NULL,
  '{"offer_code":"main"}'::JSONB,
  now()
);

DO $$
BEGIN
  ASSERT (
    SELECT count(*) = 1
    FROM public.funnel_events
    WHERE event_id = '20000000-0000-4000-8000-000000000003'::UUID
  ), 'repeated event_id must remain one row';
END;
$$;

SELECT public.complete_quiz_session(
  '10000000-0000-4000-8000-000000000001'::UUID,
  10,
  '{"score_version":"boilerplate-v1","profile":"a"}'::JSONB,
  'a',
  '20000000-0000-4000-8000-000000000004'::UUID
);

-- Completion retry deliberately uses the old expected revision. Completed
-- sessions return the immutable stored result before checking that version.
SELECT public.complete_quiz_session(
  '10000000-0000-4000-8000-000000000001'::UUID,
  10,
  '{"ignored":true}'::JSONB,
  'ignored',
  '20000000-0000-4000-8000-000000000005'::UUID
);

DO $$
BEGIN
  ASSERT (
    SELECT status = 'completed'
      AND revision = 11
      AND result_segment = 'a'
      AND quiz_result = '{"score_version":"boilerplate-v1","profile":"a"}'::JSONB
      AND completed_at IS NOT NULL
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'completion must store one immutable result on the session';
  ASSERT (
    SELECT count(*) = 1
    FROM public.funnel_events
    WHERE session_id = '10000000-0000-4000-8000-000000000001'::UUID
      AND event_type = 'quiz_completed'
  ), 'completion retry must not duplicate quiz_completed';
END;
$$;

-- ── CRO step activity ───────────────────────────────────────────────────────
-- Everything below is invisible to the vitest suites: the merge semantics live
-- entirely inside PL/pgSQL. A regression here surfaces as a silently wrong
-- drop-off report, not as a failing unit test.

-- A fresh session for the activity assertions, so the revision arithmetic above
-- stays readable.
SELECT public.create_quiz_session(
  '10000000-0000-4000-8000-000000000002'::UUID,
  NULL,
  'visitor-2',
  'boilerplate-v1',
  'main-v1',
  'en',
  'quiz',
  '{}'::JSONB,
  '{}'::JSONB,
  '20000000-0000-4000-8000-000000000010'::UUID
);

DO $$
BEGIN
  -- The catalog is unpublished inside this transaction, so the landing-step
  -- stamp must degrade to an empty object rather than failing the INSERT.
  -- Session creation is on the revenue path.
  ASSERT (
    SELECT step_activity = '{}'::JSONB
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000002'::UUID
  ), 'create must not fail or invent activity when the catalog is unseeded';
END;
$$;

-- First view of step2 + the answer for step1.
SELECT public.save_quiz_session_progress(
  '10000000-0000-4000-8000-000000000002'::UUID,
  0,
  '{"gender":"female"}'::JSONB,
  'step2',
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, '{}'::JSONB,
  '{"viewed":["step2"],"answered":["step1"],"skipped":[]}'::JSONB
);

DO $$
DECLARE
  v_activity JSONB;
BEGIN
  SELECT step_activity INTO v_activity
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;

  ASSERT (v_activity -> 'step1' ->> 'answered_at') IS NOT NULL,
    'an answered step must carry answered_at';
  ASSERT (v_activity -> 'step1' ->> 'viewed_at') IS NOT NULL,
    'answering implies a view even without an explicit viewed entry';
  ASSERT (v_activity -> 'step1' ->> 'views')::INTEGER = 1,
    'an implied view counts once';
  ASSERT (v_activity -> 'step2' ->> 'answered_at') IS NULL,
    'a viewed-but-unanswered step must keep answered_at null -- this is the whole feature';
  ASSERT (v_activity -> 'step2' ->> 'views')::INTEGER = 1,
    'first forward entry counts one view';
  ASSERT (v_activity -> 'step2' ->> 'skipped')::BOOLEAN = false,
    'skipped defaults to false';
END;
$$;

-- Re-enter step2 (back then forward) and answer it.
SELECT public.save_quiz_session_progress(
  '10000000-0000-4000-8000-000000000002'::UUID,
  1,
  '{"gender":"female","primaryGoal":"a"}'::JSONB,
  'step3',
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, '{}'::JSONB,
  '{"viewed":["step2","step3"],"answered":["step2"],"skipped":[]}'::JSONB
);

DO $$
DECLARE
  v_activity JSONB;
  v_first_view TEXT;
BEGIN
  SELECT step_activity INTO v_activity
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;

  ASSERT (v_activity -> 'step2' ->> 'views')::INTEGER = 2,
    'a second forward entry increments views';
  ASSERT (v_activity -> 'step2' ->> 'answered_at') IS NOT NULL,
    'step2 is answered on the second pass';
  ASSERT (v_activity -> 'step3' ->> 'views')::INTEGER = 1,
    'newly entered step counts one view';
END;
$$;

-- viewed_at must never move once set.
DO $$
DECLARE
  v_before TIMESTAMPTZ;
  v_after  TIMESTAMPTZ;
BEGIN
  SELECT (step_activity -> 'step3' ->> 'viewed_at')::TIMESTAMPTZ INTO v_before
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;

  PERFORM public.save_quiz_session_progress(
    '10000000-0000-4000-8000-000000000002'::UUID,
    2,
    '{"gender":"female","primaryGoal":"a"}'::JSONB,
    'step3',
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::JSONB,
    '{"viewed":["step3"],"answered":[],"skipped":[]}'::JSONB
  );

  SELECT (step_activity -> 'step3' ->> 'viewed_at')::TIMESTAMPTZ INTO v_after
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;

  ASSERT v_before = v_after, 'viewed_at is the FIRST view and must never move';
END;
$$;

-- Skip, then answer: answering clears skipped, and answered_at never moves.
SELECT public.save_quiz_session_progress(
  '10000000-0000-4000-8000-000000000002'::UUID,
  3,
  '{"gender":"female","primaryGoal":"a"}'::JSONB,
  'step4',
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, '{}'::JSONB,
  '{"viewed":["step4"],"answered":[],"skipped":["step3"]}'::JSONB
);

DO $$
DECLARE
  v_activity JSONB;
  v_answered TEXT;
BEGIN
  SELECT step_activity INTO v_activity
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;
  -- step3 was viewed but never answered, so an explicit skip does apply.
  ASSERT (v_activity -> 'step3' ->> 'skipped')::BOOLEAN = true,
    'skipping a viewed-but-unanswered step must set skipped';
  ASSERT (v_activity -> 'step3' ->> 'answered_at') IS NULL,
    'skipping must not invent an answer';

  SELECT (step_activity -> 'step2' ->> 'answered_at') INTO v_answered
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;

  PERFORM public.save_quiz_session_progress(
    '10000000-0000-4000-8000-000000000002'::UUID,
    4,
    '{"gender":"male","primaryGoal":"a"}'::JSONB,
    'step4',
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::JSONB,
    '{"viewed":[],"answered":["step2"],"skipped":[]}'::JSONB
  );

  ASSERT (
    SELECT step_activity -> 'step2' ->> 'answered_at' = v_answered
    FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID
  ), 'answered_at is the FIRST answer: re-answering after a back-edit must not move it';

  -- step2 IS answered, so a later skip of it must be ignored. Skipping never
  -- un-answers; only the absence of an answer lets the flag through.
  PERFORM public.save_quiz_session_progress(
    '10000000-0000-4000-8000-000000000002'::UUID,
    5,
    '{"gender":"male","primaryGoal":"a"}'::JSONB,
    'step4',
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::JSONB,
    '{"viewed":[],"answered":[],"skipped":["step2"]}'::JSONB
  );
  ASSERT (
    SELECT (step_activity -> 'step2' ->> 'skipped')::BOOLEAN = false
       AND step_activity -> 'step2' ->> 'answered_at' IS NOT NULL
    FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID
  ), 'skipping an already-answered step must not set skipped or clear the answer';
END;
$$;

-- A genuinely skipped step records skipped = true and no answered_at.
DO $$
BEGIN
  PERFORM public.save_quiz_session_progress(
    '10000000-0000-4000-8000-000000000002'::UUID,
    6,
    '{"gender":"male","primaryGoal":"a"}'::JSONB,
    'step6',
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::JSONB,
    '{"viewed":["step6"],"answered":[],"skipped":["step5"]}'::JSONB
  );
  ASSERT (
    SELECT step_activity -> 'step5' ->> 'skipped' = 'true'
       AND step_activity -> 'step5' ->> 'answered_at' IS NULL
    FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID
  ), 'an explicit skip is distinguishable from an unanswered view';
END;
$$;

-- A NULL delta leaves the document untouched, so every pre-existing caller
-- (and the 13-argument positional form) is a no-op for step activity.
DO $$
DECLARE
  v_before JSONB;
BEGIN
  SELECT step_activity INTO v_before
  FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID;

  PERFORM public.save_quiz_session_progress(
    '10000000-0000-4000-8000-000000000002'::UUID,
    7,
    '{"gender":"male","primaryGoal":"a"}'::JSONB,
    'step6',
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::JSONB
  );

  ASSERT (
    SELECT step_activity = v_before
    FROM public.sessions WHERE id = '10000000-0000-4000-8000-000000000002'::UUID
  ), 'a 13-argument call must leave step_activity untouched';
END;
$$;

-- Oversized activity raises the sentinel the API turns into a 413.
DO $$
DECLARE
  v_delta JSONB;
BEGIN
  SELECT jsonb_build_object(
           'viewed',
           jsonb_agg('step_' || g::TEXT)
         )
    INTO v_delta
  FROM generate_series(1, 260) AS g;

  BEGIN
    PERFORM public.save_quiz_session_progress(
      '10000000-0000-4000-8000-000000000002'::UUID,
      8,
      '{"gender":"male","primaryGoal":"a"}'::JSONB,
      'step6',
      NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, '{}'::JSONB,
      v_delta
    );
    RAISE EXCEPTION 'oversized step activity unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      ASSERT SQLERRM = 'QUIZ_STEP_ACTIVITY_TOO_LARGE',
        'oversized activity must raise QUIZ_STEP_ACTIVITY_TOO_LARGE, got: ' || SQLERRM;
  END;
END;
$$;


-- ── CRO definition catalog ──────────────────────────────────────────────────

SELECT public.publish_quiz_definition(
  'catalog-test-v1', 'testapp', 'main', 'stepA', 3,
  repeat('a', 64),
  '[
     {"step_id":"stepA","position":1,"sort_index":1,"step_type":"radio",
      "phase_key":"phases.start","store_as":"goal","is_question":true,
      "is_terminal":false,"answer_keys":["goal"],
      "label_key":"steps.stepA.question","label":"What is your main goal?",
      "is_unconditional":true,"entry_skippable":false,
      "next":[{"to_step_id":"stepB","on_value":"x"},
              {"to_step_id":"stepC","on_value":"y"}]},
     {"step_id":"stepB","position":2,"sort_index":2,"step_type":"multi_select",
      "phase_key":"phases.about","store_as":"items","is_question":true,
      "is_terminal":false,"answer_keys":["items"],
      "label_key":"steps.stepB.question","label":"Which challenges?",
      "is_unconditional":false,"entry_skippable":false,
      "next":[{"to_step_id":"stepD","on_value":null}]},
     {"step_id":"stepC","position":2,"sort_index":3,"step_type":"checkpoint",
      "phase_key":"phases.about","store_as":null,"is_question":false,
      "is_terminal":false,"answer_keys":[],
      "label_key":"steps.stepC.title","label":"Here is what that means",
      "is_unconditional":false,"entry_skippable":false,
      "next":[{"to_step_id":"stepD","on_value":null}]},
     {"step_id":"stepD","position":3,"sort_index":4,"step_type":"loading_screen",
      "phase_key":"phases.account","store_as":null,"is_question":false,
      "is_terminal":true,"answer_keys":[],
      "label_key":"steps.stepD.brand","label":"Building your plan",
      "is_unconditional":true,"entry_skippable":false,"next":[]}
   ]'::JSONB
);

DO $$
BEGIN
  ASSERT (
    SELECT count(*) = 4 FROM public.quiz_definition_steps
    WHERE quiz_variant = 'catalog-test-v1'
  ), 'publish must insert one row per step, keyed on step_id not position';
  -- stepB and stepC share position 2. Keying on position would lose an arm.
  ASSERT (
    SELECT count(*) = 2 FROM public.quiz_definition_steps
    WHERE quiz_variant = 'catalog-test-v1' AND position = 2
  ), 'branch arms sharing a position must both persist';
  ASSERT (
    SELECT count(*) = 2 FROM public.quiz_definition_step_edges
    WHERE quiz_variant = 'catalog-test-v1' AND from_step_id = 'stepA'
  ), 'a branching step must publish one edge per option';
  ASSERT (
    SELECT count(*) = 0 FROM public.quiz_definition_step_edges
    WHERE quiz_variant = 'catalog-test-v1' AND from_step_id = 'stepD'
  ), 'terminal steps must publish no edges (no self-loop)';
END;
$$;

-- Re-publishing the SAME hash is a no-op, not an immutability violation.
DO $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT public.publish_quiz_definition(
    'catalog-test-v1', 'testapp', 'main', 'stepA', 3, repeat('a', 64),
    '[{"step_id":"stepA","position":1,"sort_index":1,"step_type":"radio",
       "is_question":true,"is_terminal":false,"answer_keys":["goal"],"next":[]}]'::JSONB
  ) INTO v_result;
  ASSERT v_result ->> 'result' = 'unchanged',
    'republishing an identical hash must short-circuit before writing';
  ASSERT (
    SELECT count(*) = 4 FROM public.quiz_definition_steps
    WHERE quiz_variant = 'catalog-test-v1'
  ), 'the no-op path must not touch the published steps';
END;
$$;

-- A CHANGED config under the SAME variant is the workflow error this enforces.
DO $$
BEGIN
  BEGIN
    PERFORM public.publish_quiz_definition(
      'catalog-test-v1', 'testapp', 'main', 'stepA', 3, repeat('b', 64),
      '[{"step_id":"stepA","position":1,"sort_index":1,"step_type":"radio",
         "is_question":true,"is_terminal":false,"answer_keys":["goal"],"next":[]}]'::JSONB
    );
    RAISE EXCEPTION 'drifted republish unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      ASSERT SQLERRM LIKE 'QUIZ_DEFINITION_DRIFT:%',
        'a changed config under the same quiz_variant must raise QUIZ_DEFINITION_DRIFT, got: ' || SQLERRM;
  END;
END;
$$;

-- A published definition is frozen against direct writes too.
DO $$
BEGIN
  BEGIN
    UPDATE public.quiz_definitions SET total_steps = 99
    WHERE quiz_variant = 'catalog-test-v1';
    RAISE EXCEPTION 'definition update unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      ASSERT SQLERRM LIKE 'QUIZ_DEFINITION_IMMUTABLE:%',
        'published definitions must be immutable, got: ' || SQLERRM;
  END;

  BEGIN
    DELETE FROM public.quiz_definition_steps WHERE quiz_variant = 'catalog-test-v1';
    RAISE EXCEPTION 'step delete unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      ASSERT SQLERRM LIKE 'QUIZ_DEFINITION_IMMUTABLE:%',
        'published steps must not be deletable, got: ' || SQLERRM;
  END;
END;
$$;

-- create_quiz_session stamps the landing step once the catalog knows the quiz.
SELECT public.create_quiz_session(
  '10000000-0000-4000-8000-000000000003'::UUID,
  NULL, 'visitor-3', 'catalog-test-v1', 'main-v1', 'en', 'quiz',
  '{}'::JSONB, '{}'::JSONB,
  '20000000-0000-4000-8000-000000000020'::UUID
);

DO $$
BEGIN
  ASSERT (
    SELECT step_activity -> 'stepA' ->> 'viewed_at' IS NOT NULL
       AND (step_activity -> 'stepA' ->> 'views')::INTEGER = 1
       AND step_activity -> 'stepA' ->> 'answered_at' IS NULL
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000003'::UUID
  ), 'create must stamp the first step as viewed-not-answered when published';
END;
$$;

-- ── The CRO read API is analyst-gated ───────────────────────────────────────
-- cro_step_funnel raises 42501 unless is_cro_analyst() passes, so the
-- assertions below have to run as a real caller would. Proving the guard fires
-- comes first: a test that silently ran as an unguarded superuser would keep
-- passing the day someone removed the gate.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"email":"stranger@example.com"}', true);
  BEGIN
    PERFORM * FROM public.cro_step_funnel(
      now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
    );
    RAISE EXCEPTION 'cro_step_funnel answered a non-analyst';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;  -- 42501, which is what apps/cro branches on
  END;
END;
$$;

-- A fixture address, not a plausible real one, and ON CONFLICT so the script
-- still runs against a database that already has analysts in it. Rolled back
-- with everything else at the end.
INSERT INTO public.cro_analysts (email, note)
VALUES ('quiz-backend-fixture@example.test', 'quiz_backend fixture')
ON CONFLICT (email) DO NOTHING;

-- Mixed case on the claim, lowercase in the table: is_cro_analyst() lowers both
-- sides, and a mismatch here would lock out every analyst whose mail client
-- capitalises their address.
SELECT set_config('request.jwt.claims', '{"email":"Quiz-Backend-Fixture@Example.TEST"}', true);

-- cro_step_funnel: a branch arm the visitor did not take is NOT a drop.
DO $$
DECLARE
  v_stepa RECORD;
BEGIN
  -- Take the stepA -> stepB arm and stop there.
  PERFORM public.save_quiz_session_progress(
    '10000000-0000-4000-8000-000000000003'::UUID,
    0,
    '{"goal":"x"}'::JSONB,
    'stepB',
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::JSONB,
    '{"viewed":["stepB"],"answered":["stepA"],"skipped":[]}'::JSONB
  );
  -- Age the row past the settle window so it is eligible to count as dropped.
  UPDATE public.sessions
  SET updated_at = now() - INTERVAL '1 day'
  WHERE id = '10000000-0000-4000-8000-000000000003'::UUID;

  SELECT * INTO v_stepa
  FROM public.cro_step_funnel(
    now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
  )
  WHERE step_id = 'stepA';

  ASSERT v_stepa.viewed = 1, 'stepA was viewed once';
  ASSERT v_stepa.answered = 1, 'stepA was answered';
  ASSERT v_stepa.in_catalog, 'stepA must resolve against the published catalog';
  ASSERT v_stepa.advanced = 1,
    'stepA advanced: one of its successors (stepB) was viewed';
  ASSERT v_stepa.dropped = 0,
    'taking one branch arm must not count the other arm as a drop';

  -- The arm the visitor did NOT take still produces a row, flagged
  -- has_traffic = false. It used to vanish, which made "nobody reached it"
  -- indistinguishable from "it does not exist" -- and hid a routing bug that
  -- shows a step to zero people.
  ASSERT (
    SELECT NOT has_traffic AND viewed = 0 AND dropped = 0 AND NOT is_unconditional
    FROM public.cro_step_funnel(
      now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
    ) WHERE step_id = 'stepC'
  ), 'an untraversed branch arm must appear with no traffic, never as a drop';

  -- The terminal step nobody reached is present too, so the funnel list does
  -- not silently end at the deepest step anyone got to.
  ASSERT (
    SELECT NOT has_traffic AND dropped = 0
    FROM public.cro_step_funnel(
      now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
    ) WHERE step_id = 'stepD'
  ), 'an unreached terminal step must still appear, and never count as dropped';

  -- Labels are resolved sentences, not i18n keys: every string in
  -- quiz-config.ts is a key, so a dashboard fed the config alone would title
  -- its rows 'steps.stepA.question'.
  ASSERT (
    SELECT label = 'What is your main goal?'
    FROM public.cro_step_funnel(
      now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
    ) WHERE step_id = 'stepA'
  ), 'the catalog must publish resolved label text';

  -- stepA is on every route; stepB and stepC are arms of its branch.
  ASSERT (
    SELECT bool_and(is_unconditional = (step_id IN ('stepA', 'stepD')))
    FROM public.cro_step_funnel(
      now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
    )
  ), 'only steps on every route may be marked unconditional';

  ASSERT (
    SELECT dropped = 1 FROM public.cro_step_funnel(
      now() - INTERVAL '1 hour', now() + INTERVAL '1 hour', 'catalog-test-v1'
    ) WHERE step_id = 'stepB'
  ), 'stepB was viewed, never advanced past, and is settled -- that is a drop';
END;
$$;

ROLLBACK;

\echo 'quiz_backend PASSED'
