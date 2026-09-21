-- QUIZ BACKEND REFERENCE SCHEMA
--
-- Documentation only. This file is intentionally outside supabase/migrations.
-- Do not apply it automatically to this repository's existing database.
-- It shows the quiz-focused two-table shape for a fresh product and omits
-- payment-specific columns already present on sessions. The executable source
-- of truth is supabase/migrations/00001_baseline.sql; never apply this file.

create table public.sessions (
  id uuid primary key default gen_random_uuid(),

  -- Identity. Neither visitor_id nor email is authorization.
  user_id uuid references auth.users(id) on delete set null,
  visitor_id text,
  email text,

  -- Current quiz truth: one complete answer object and one final result.
  quiz_answers jsonb not null default '{}'::jsonb,
  quiz_result jsonb,
  result_segment text,
  current_step_id text,
  status text not null default 'active'
    check (status in ('active', 'completed', 'abandoned', 'expired')),
  revision integer not null default 0 check (revision >= 0),

  -- Version and entry context.
  quiz_variant text not null,
  funnel_variant text not null,
  locale text not null,
  source text not null default 'quiz',
  attribution jsonb not null default '{}'::jsonb,
  client_context jsonb not null default '{}'::jsonb,

  -- Consent and downstream handoff state.
  consent_given_at timestamptz,
  consent_version text,
  marketing_consent boolean default true,
  welcome_email_pending boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  check (jsonb_typeof(quiz_answers) = 'object'),
  check (quiz_result is null or jsonb_typeof(quiz_result) = 'object'),
  check (jsonb_typeof(attribution) = 'object'),
  check (jsonb_typeof(client_context) = 'object'),
  check (email is null or length(email) <= 320),
  check (visitor_id is null or length(visitor_id) between 1 and 255),
  check (length(quiz_variant) between 1 and 100),
  check (length(funnel_variant) between 1 and 100),
  check (length(locale) between 1 and 35),
  check (length(source) between 1 and 100),
  check (current_step_id is null or length(current_step_id) <= 100),
  check ((status = 'completed') = (completed_at is not null))
);

create index sessions_user_idx
  on public.sessions (user_id, created_at desc)
  where user_id is not null;

create index sessions_visitor_idx
  on public.sessions (visitor_id, created_at desc)
  where visitor_id is not null;

create index sessions_email_idx
  on public.sessions (lower(email))
  where email is not null;

create index sessions_reporting_idx
  on public.sessions (created_at, funnel_variant, quiz_variant, source, status);

create table public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  session_id uuid not null
    references public.sessions(id) on delete cascade,
  event_type text not null,
  step_number integer,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  check (length(event_type) between 1 and 100),
  check (step_number is null or step_number >= 0),
  check (jsonb_typeof(metadata) = 'object')
);

create index funnel_events_session_idx
  on public.funnel_events (session_id, occurred_at, id);

create index funnel_events_type_idx
  on public.funnel_events (event_type, occurred_at);

-- Runtime responsibilities not expressible fully in this reference DDL:
-- 1. Validate quiz_answers against the immutable sessions.quiz_variant.
-- 2. Enforce JSON byte limits.
-- 3. Update with an optimistic revision predicate.
-- 4. Compute quiz_result on the server.
-- 5. Commit state and required events in one transaction.
-- 6. Enforce authenticated ownership or a signed anonymous-session credential.
-- 7. Define RLS policies for the host project; do not grant unrestricted writes.
