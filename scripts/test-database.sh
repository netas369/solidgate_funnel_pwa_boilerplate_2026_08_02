#!/usr/bin/env bash
set -euo pipefail

admin_db_container="admin-boilerplate-db-$$"

cleanup_admin_db() {
  docker rm -f "${admin_db_container}" >/dev/null 2>&1 || true
}
trap cleanup_admin_db EXIT

docker run -d --name "${admin_db_container}" --tmpfs /pgdata:rw,size=512m \
  -e PGDATA=/pgdata -e POSTGRES_PASSWORD=postgres postgres:17-alpine >/dev/null

for _admin_db_attempt in {1..30}; do
  if docker exec "${admin_db_container}" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${admin_db_container}" pg_isready -U postgres >/dev/null

docker exec -i "${admin_db_container}" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS dblink;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE ROLE supabase_admin LOGIN SUPERUSER;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);
CREATE TABLE auth.sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID);
CREATE TABLE auth.refresh_tokens (
  id BIGSERIAL PRIMARY KEY, session_id UUID, revoked BOOLEAN DEFAULT false);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS 'SELECT NULL::UUID';
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
SQL

for admin_db_migration in supabase/migrations/*.sql; do
  docker exec -i "${admin_db_container}" psql -U postgres -v ON_ERROR_STOP=1 -q \
    < "${admin_db_migration}"
done

for admin_db_test in supabase/tests/*.sql; do
  echo "== ${admin_db_test}"
  docker exec -i "${admin_db_container}" psql -U postgres -v ON_ERROR_STOP=1 \
    -v "round2_dblink_conn=host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres" \
    < "${admin_db_test}"
done

# The concurrency suite is deliberately rerun to prove cleanup is retry-safe.
docker exec -i "${admin_db_container}" psql -U postgres -v ON_ERROR_STOP=1 \
  -v "round2_dblink_conn=host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres" \
  < supabase/tests/solidgate_round2_concurrency.sql
