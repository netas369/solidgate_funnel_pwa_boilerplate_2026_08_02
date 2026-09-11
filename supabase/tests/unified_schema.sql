\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_conversation_id UUID;
  v_open_count INTEGER;
  v_event_count INTEGER;
  v_title TEXT;
  v_opening_preview TEXT;
  v_preview TEXT;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_user_id, 'unified-schema@example.test');

  SELECT app_open_count
  INTO v_open_count
  FROM public.record_user_app_open(
    v_user_id, 'en', 'schema-test', 'test', 'open:fixed-key'
  );
  ASSERT v_open_count = 1, format('first app open count: %s', v_open_count);

  SELECT app_open_count
  INTO v_open_count
  FROM public.record_user_app_open(
    v_user_id, 'en', 'schema-test', 'test', 'open:fixed-key'
  );
  ASSERT v_open_count = 1, format('duplicate app open inflated count: %s', v_open_count);

  SELECT COUNT(*)
  INTO v_event_count
  FROM public.analytics_events
  WHERE project_key = 'schema-test'
    AND event_key = 'open:fixed-key';
  ASSERT v_event_count = 1, format('app-open event count: %s', v_event_count);

  ASSERT NOT has_table_privilege('anon', 'public.analytics_events', 'SELECT'),
    'anon can select private analytics';
  ASSERT NOT has_table_privilege('authenticated', 'public.analytics_events', 'INSERT'),
    'authenticated can insert directly into private analytics';
  ASSERT has_table_privilege('service_role', 'public.analytics_events', 'INSERT'),
    'service role cannot write internal analytics';

  INSERT INTO public.advisor_conversations (user_id)
  VALUES (v_user_id)
  RETURNING id INTO v_conversation_id;

  INSERT INTO public.advisor_messages (
    conversation_id, client_message_id, role, message_content
  )
  VALUES (
    v_conversation_id, gen_random_uuid(), 'user',
    'How can I improve my weekly plan?'
  );

  INSERT INTO public.advisor_messages (
    conversation_id, role, message_content
  )
  VALUES (
    v_conversation_id, 'advisor', 'Start with one measurable priority.'
  );

  SELECT title, preview, last_message_preview
  INTO v_title, v_opening_preview, v_preview
  FROM public.advisor_conversations
  WHERE id = v_conversation_id;

  ASSERT v_title = 'How can I improve my weekly plan?',
    format('conversation title: %s', v_title);
  ASSERT v_opening_preview = 'Start with one measurable priority.',
    format('conversation opening preview: %s', v_opening_preview);
  ASSERT v_preview = 'Start with one measurable priority.',
    format('conversation preview: %s', v_preview);
END;
$$;

ROLLBACK;

\echo 'unified_schema.sql PASSED'
