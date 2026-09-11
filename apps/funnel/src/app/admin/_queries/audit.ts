import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';

export interface AdminAuditRow {
  id: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  customerDigestPrefix: string;
  createdAt: string;
  completedAt: string | null;
}

export async function recentAdminAudit(limit = 100): Promise<{
  rows: AdminAuditRow[];
  warning: string | null;
}> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('support_action_audit')
    .select('id,action,outcome,actor_user_id,customer_email_hash,created_at,completed_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error || !data) {
    console.error('[admin/audit] recent audit read failed:', error?.message);
    return { rows: [], warning: 'The support action audit is unavailable.' };
  }
  return {
    rows: data.map((row) => ({
      id: row.id,
      action: row.action,
      outcome: row.outcome,
      actorUserId: row.actor_user_id,
      customerDigestPrefix: row.customer_email_hash.slice(0, 12),
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
    warning: null,
  };
}
