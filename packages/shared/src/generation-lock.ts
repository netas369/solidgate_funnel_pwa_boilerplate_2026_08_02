import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types/database';

type AdminClient = SupabaseClient<Database>;

export interface AcquireLockResult {
  acquired: boolean;
  /** When the current holder's lock expires (only present when acquired=false). */
  heldUntil?: string;
}

/**
 * Try to acquire a single-flight generation lock.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING as the atomic gate. Expired holders
 * are deleted opportunistically before the insert, so a crashed request that
 * never released its lock cannot block forever.
 *
 * Returns `{acquired: true}` if this caller owns the lock and may proceed with
 * the expensive work. Returns `{acquired: false, heldUntil}` if another caller
 * is already running — the caller should fall back to cached/stale data and
 * NOT trigger the AI call.
 */
export async function acquireGenerationLock(
  admin: AdminClient,
  scope: string,
  scopeKey: string,
  ttlSeconds = 300,
): Promise<AcquireLockResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  // Sweep our own expired row so a stale lock doesn't block us. Scoped to
  // the exact key we care about to keep the query cheap.
  await admin
    .from('generation_locks')
    .delete()
    .eq('scope', scope)
    .eq('scope_key', scopeKey)
    .lt('expires_at', now.toISOString());

  const { error: insertErr } = await admin
    .from('generation_locks')
    .insert({
      scope,
      scope_key: scopeKey,
      acquired_at: now.toISOString(),
      expires_at: expiresAt,
    });

  if (!insertErr) {
    return { acquired: true };
  }

  // 23505 = unique_violation. Anything else is a real failure — surface it so
  // the caller can decide (we err on the safe side: treat unknown errors as
  // "lock held" so we never duplicate an expensive AI call).
  const code = (insertErr as { code?: string }).code;
  if (code && code !== '23505') {
    console.error(
      `[generation-lock] unexpected acquire error for ${scope}/${scopeKey}`,
      insertErr,
    );
  }

  const { data: holder } = await admin
    .from('generation_locks')
    .select('expires_at')
    .eq('scope', scope)
    .eq('scope_key', scopeKey)
    .maybeSingle();

  return { acquired: false, heldUntil: holder?.expires_at };
}

/**
 * Release a generation lock. Safe to call even if the lock has already
 * expired or been deleted — DELETE returns silently in that case.
 */
export async function releaseGenerationLock(
  admin: AdminClient,
  scope: string,
  scopeKey: string,
): Promise<void> {
  const { error } = await admin
    .from('generation_locks')
    .delete()
    .eq('scope', scope)
    .eq('scope_key', scopeKey);
  if (error) {
    console.error(
      `[generation-lock] release failed for ${scope}/${scopeKey}`,
      error,
    );
  }
}

/**
 * Convenience wrapper: acquire → run work → release. Returns whatever `work`
 * returns wrapped in `{ran: true, result}`. If the lock was held by someone
 * else, returns `{ran: false, heldUntil}` without running `work`.
 *
 * `work` is always followed by release, even on throw — the lock cannot leak.
 */
export async function withGenerationLock<T>(
  admin: AdminClient,
  scope: string,
  scopeKey: string,
  work: () => Promise<T>,
  ttlSeconds = 300,
): Promise<
  { ran: true; result: T } | { ran: false; heldUntil: string | undefined }
> {
  const lock = await acquireGenerationLock(admin, scope, scopeKey, ttlSeconds);
  if (!lock.acquired) {
    return { ran: false, heldUntil: lock.heldUntil };
  }
  try {
    const result = await work();
    return { ran: true, result };
  } finally {
    await releaseGenerationLock(admin, scope, scopeKey);
  }
}
