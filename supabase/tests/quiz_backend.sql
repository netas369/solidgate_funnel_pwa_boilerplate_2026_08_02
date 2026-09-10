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

ROLLBACK;

\echo 'quiz_backend PASSED'
