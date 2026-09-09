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

SELECT public.persist_quiz_session_snapshot(
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
  ), 'snapshot writes must not create answer rows or extra sessions';
  ASSERT (
    SELECT revision = 1
      AND quiz_answers = '{"gender":"female","primaryGoal":"a"}'::JSONB
      AND current_step_id = 'step2'
    FROM public.sessions
    WHERE id = '10000000-0000-4000-8000-000000000001'::UUID
  ), 'snapshot must replace current JSONB state and advance revision';
  ASSERT (
    SELECT count(*) = 1
    FROM public.funnel_events
    WHERE session_id = '10000000-0000-4000-8000-000000000001'::UUID
      AND event_type = 'step_completed'
      AND step_number = 1
  ), 'snapshot and step milestone must commit together';
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.persist_quiz_session_snapshot(
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
      ASSERT SQLERRM = 'QUIZ_STALE_REVISION:1';
  END;

  ASSERT (
    SELECT quiz_answers = '{"gender":"female","primaryGoal":"a"}'::JSONB
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
  1,
  '{"score_version":"boilerplate-v1","profile":"a"}'::JSONB,
  'a',
  '20000000-0000-4000-8000-000000000004'::UUID
);

-- Completion retry deliberately uses the old expected revision. Completed
-- sessions return the immutable stored result before checking that version.
SELECT public.complete_quiz_session(
  '10000000-0000-4000-8000-000000000001'::UUID,
  1,
  '{"ignored":true}'::JSONB,
  'ignored',
  '20000000-0000-4000-8000-000000000005'::UUID
);

DO $$
BEGIN
  ASSERT (
    SELECT status = 'completed'
      AND revision = 2
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
