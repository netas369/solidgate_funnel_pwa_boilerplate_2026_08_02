\set ON_ERROR_STOP on

-- PostgREST before v16 retries any transaction that fails with SQLSTATE 40001
-- and never gives up, so an RPC that raises it on purpose loops inside the
-- database until PostgREST restarts. Conflicts are raised as PT409 instead.
DO $$
DECLARE
  v_offenders TEXT;
BEGIN
  SELECT string_agg(p.oid::regprocedure::TEXT, ', ' ORDER BY p.oid::regprocedure::TEXT)
  INTO v_offenders
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~* '''40001''|serialization_failure';

  ASSERT v_offenders IS NULL,
    format('raises 40001, which PostgREST retries forever: %s', v_offenders);
END;
$$;

\echo 'postgrest_retry_codes PASSED'
