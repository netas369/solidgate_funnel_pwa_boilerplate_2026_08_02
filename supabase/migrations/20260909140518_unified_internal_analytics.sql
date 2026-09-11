-- Unified first-party analytics contract shared by the funnel, member area,
-- payment webhooks, and the future cross-project analytics exporter.
--
-- Analytics writes are server-only. Browser code posts to an authenticated or
-- session-aware application route, which binds user/session identity and adds
-- the project key. The central dashboard/exporter reads with service_role.

ALTER TABLE public.user_prefs
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notifications_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timezone TEXT;

ALTER TABLE public.user_prefs
  DROP CONSTRAINT IF EXISTS user_prefs_display_name_check,
  ADD CONSTRAINT user_prefs_display_name_check CHECK (
    display_name IS NULL
    OR (
      display_name = BTRIM(display_name)
      AND CHAR_LENGTH(display_name) BETWEEN 1 AND 100
    )
  ),
  DROP CONSTRAINT IF EXISTS user_prefs_timezone_check,
  ADD CONSTRAINT user_prefs_timezone_check CHECK (
    timezone IS NULL
    OR (
      timezone = BTRIM(timezone)
      AND CHAR_LENGTH(timezone) BETWEEN 1 AND 100
    )
  );

CREATE TABLE IF NOT EXISTS public.analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key TEXT NOT NULL,
  deployment_environment TEXT NOT NULL DEFAULT 'production',
  source_app TEXT NOT NULL,
  source_channel TEXT NOT NULL DEFAULT 'client',
  event_key TEXT NOT NULL,
  event_name TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  insert_id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
  properties JSONB NOT NULL DEFAULT '{}'::JSONB,
  schema_version SMALLINT NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT analytics_events_project_key_check CHECK (
    project_key = LOWER(project_key)
    AND project_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'
  ),
  CONSTRAINT analytics_events_deployment_environment_check CHECK (
    deployment_environment IN ('production', 'preview', 'development', 'test', 'sandbox')
  ),
  CONSTRAINT analytics_events_source_app_check CHECK (
    source_app IN ('funnel', 'pwa', 'system')
  ),
  CONSTRAINT analytics_events_source_channel_check CHECK (
    source_channel IN ('client', 'server', 'webhook')
  ),
  CONSTRAINT analytics_events_event_key_check CHECK (
    event_key = BTRIM(event_key)
    AND CHAR_LENGTH(event_key) BETWEEN 1 AND 240
  ),
  CONSTRAINT analytics_events_event_name_check CHECK (
    event_name ~ '^[a-z][a-z0-9_]{0,79}$'
  ),
  CONSTRAINT analytics_events_distinct_id_check CHECK (
    distinct_id = BTRIM(distinct_id)
    AND CHAR_LENGTH(distinct_id) BETWEEN 1 AND 240
  ),
  CONSTRAINT analytics_events_properties_object_check CHECK (
    JSONB_TYPEOF(properties) = 'object'
  ),
  CONSTRAINT analytics_events_properties_size_check CHECK (
    OCTET_LENGTH(properties::TEXT) <= 65536
  ),
  CONSTRAINT analytics_events_schema_version_check CHECK (
    schema_version BETWEEN 1 AND 32767
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_dedupe_key
  ON public.analytics_events (
    project_key,
    deployment_environment,
    source_app,
    event_key
  );
CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_insert_id_key
  ON public.analytics_events (
    project_key,
    deployment_environment,
    insert_id
  );
CREATE INDEX IF NOT EXISTS analytics_events_project_time_idx
  ON public.analytics_events (project_key, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS analytics_events_export_cursor_idx
  ON public.analytics_events (project_key, created_at, id);
CREATE INDEX IF NOT EXISTS analytics_events_name_time_idx
  ON public.analytics_events (project_key, event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_user_time_idx
  ON public.analytics_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_events_session_time_idx
  ON public.analytics_events (session_id, occurred_at DESC)
  WHERE session_id IS NOT NULL;

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analytics_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analytics_events TO service_role;

-- Preserve any lifecycle analytics already queued by a pre-migration webhook.
-- The project key cannot be inferred inside Postgres, so exporters can either
-- map `unconfigured` from the source connection or replace it during setup.
INSERT INTO public.analytics_events (
  project_key,
  deployment_environment,
  source_app,
  source_channel,
  event_key,
  event_name,
  distinct_id,
  insert_id,
  user_id,
  session_id,
  properties,
  occurred_at,
  created_at
)
SELECT
  'unconfigured',
  legacy.environment,
  CASE
    WHEN legacy.properties->>'app' = 'pwa' THEN 'pwa'
    WHEN legacy.properties->>'app' = 'funnel' THEN 'funnel'
    ELSE 'system'
  END,
  'webhook',
  BTRIM(LEFT(legacy.event_key, 240)),
  legacy.event_name,
  BTRIM(LEFT(legacy.distinct_id, 240)),
  legacy.insert_id,
  -- Legacy payload identity is retained in properties/distinct_id. Avoid
  -- creating dangling foreign keys when an old user or session was deleted.
  NULL,
  NULL,
  CASE
    WHEN JSONB_TYPEOF(legacy.properties) = 'object'
      AND OCTET_LENGTH(legacy.properties::TEXT) <= 65536
      THEN legacy.properties
    ELSE JSONB_BUILD_OBJECT('legacy_payload_omitted', TRUE)
  END,
  legacy.created_at,
  legacy.created_at
FROM public.solidgate_analytics_outbox AS legacy
WHERE legacy.event_name ~ '^[a-z][a-z0-9_]{0,79}$'
  AND BTRIM(legacy.event_key) <> ''
  AND BTRIM(legacy.distinct_id) <> ''
ON CONFLICT DO NOTHING;

DROP FUNCTION IF EXISTS public.claim_solidgate_analytics_outbox(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS public.solidgate_analytics_outbox;

-- Idempotent app-open recording. Retrying the same event key does not inflate
-- app_open_count, and the event plus counter commit in one transaction.
CREATE OR REPLACE FUNCTION public.record_user_app_open(
  p_user_id UUID,
  p_default_locale TEXT,
  p_project_key TEXT,
  p_deployment_environment TEXT,
  p_event_key TEXT
)
RETURNS TABLE (
  app_open_count INTEGER,
  last_active_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inserted BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.analytics_events (
    project_key,
    deployment_environment,
    source_app,
    source_channel,
    event_key,
    event_name,
    distinct_id,
    user_id,
    properties
  )
  VALUES (
    p_project_key,
    p_deployment_environment,
    'pwa',
    'server',
    p_event_key,
    'app_opened',
    p_user_id::TEXT,
    p_user_id,
    JSONB_BUILD_OBJECT('idle_window_minutes', 30)
  )
  ON CONFLICT (project_key, deployment_environment, source_app, event_key)
    DO NOTHING;

  v_inserted := FOUND;

  IF v_inserted THEN
    INSERT INTO public.user_prefs (
      user_id,
      locale,
      app_open_count,
      last_active_at
    )
    VALUES (p_user_id, p_default_locale, 1, now())
    ON CONFLICT (user_id) DO UPDATE
      SET app_open_count = public.user_prefs.app_open_count + 1,
          last_active_at = now();
  END IF;

  RETURN QUERY
  SELECT prefs.app_open_count, prefs.last_active_at
  FROM public.user_prefs AS prefs
  WHERE prefs.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_user_app_open(UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_app_open(UUID, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON TABLE public.analytics_events IS
  'Canonical first-party analytics event stream. Export this stable contract to the unified cross-project dashboard.';
COMMENT ON COLUMN public.analytics_events.project_key IS
  'Stable lowercase identifier configured with ANALYTICS_PROJECT_KEY in every app and webhook runtime.';
COMMENT ON COLUMN public.analytics_events.event_key IS
  'Producer-supplied idempotency key, unique within project/environment/source app.';
