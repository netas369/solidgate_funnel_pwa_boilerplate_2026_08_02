-- Project-agnostic audit trail for mutations performed from /admin/support.
-- Customer email is stored only as a SHA-256 digest; the support UI resolves
-- the account again for every action and never trusts a client-provided user id.
CREATE TABLE IF NOT EXISTS public.support_action_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL CHECK (action IN ('send_login_code', 'revoke_sessions')),
  customer_email_hash TEXT NOT NULL CHECK (customer_email_hash ~ '^[0-9a-f]{64}$'),
  customer_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL DEFAULT 'started'
    CHECK (outcome IN ('started', 'success', 'failed', 'refused')),
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_action_audit_customer_time
  ON public.support_action_audit (customer_email_hash, created_at DESC);

ALTER TABLE public.support_action_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_action_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.support_action_audit TO service_role;
