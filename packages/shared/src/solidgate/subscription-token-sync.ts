import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '../supabase/admin';
import type { PaymentEnvironment } from '../payment-environment';
import { getSolidgateKeys, SolidgateClient } from './client';

type RpcError = { message: string } | null;
type RpcClient = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: RpcError }>;

export interface SubscriptionTokenSyncJob {
  payment_environment: PaymentEnvironment;
  user_id: string;
  solidgate_subscription_id: string;
  desired_source_kind: 'main_order' | 'pwa_order' | 'card_update';
  desired_source_id: string;
  claim_token: string;
}

interface ClaimedSyncState {
  desired_source_kind: SubscriptionTokenSyncJob['desired_source_kind'];
  desired_source_id: string;
  card_token: string;
  subscription_is_billable: boolean;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ))
    : [];
}

function claimedState(value: unknown): ClaimedSyncState | null {
  const row = rows(value)[0];
  if (
    !row ||
    !['main_order', 'pwa_order', 'card_update'].includes(String(row.desired_source_kind)) ||
    typeof row.desired_source_id !== 'string' ||
    typeof row.card_token !== 'string' ||
    !row.card_token ||
    typeof row.subscription_is_billable !== 'boolean'
  ) return null;
  return row as unknown as ClaimedSyncState;
}

function providerError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || Array.isArray(error)) return 'Solidgate token update failed';
  const record = error as Record<string, unknown>;
  if (typeof record.recommended_message_for_user === 'string') {
    return record.recommended_message_for_user;
  }
  if (typeof record.code === 'string') return record.code;
  return 'Solidgate token update failed';
}

async function readClaimedState(
  rpc: RpcClient,
  job: SubscriptionTokenSyncJob,
): Promise<ClaimedSyncState | null> {
  const { data, error } = await rpc('read_claimed_solidgate_subscription_token_sync', {
    p_payment_environment: job.payment_environment,
    p_user_id: job.user_id,
    p_solidgate_subscription_id: job.solidgate_subscription_id,
    p_claim_token: job.claim_token,
  });
  if (error) throw new Error(`subscription-token sync read failed: ${error.message}`);
  return claimedState(data);
}

async function completeExactGeneration(
  rpc: RpcClient,
  job: SubscriptionTokenSyncJob,
  state: ClaimedSyncState,
  requireNonbillable = false,
): Promise<boolean> {
  const { data, error } = await rpc('complete_solidgate_subscription_token_sync', {
    p_payment_environment: job.payment_environment,
    p_user_id: job.user_id,
    p_solidgate_subscription_id: job.solidgate_subscription_id,
    p_claim_token: job.claim_token,
    p_desired_source_kind: state.desired_source_kind,
    p_desired_source_id: state.desired_source_id,
    p_require_nonbillable: requireNonbillable,
  });
  if (error) throw new Error(`subscription-token sync completion failed: ${error.message}`);
  return data === true;
}

async function failExactGeneration(
  rpc: RpcClient,
  job: SubscriptionTokenSyncJob,
  state: ClaimedSyncState,
  cause: unknown,
): Promise<boolean> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const { data, error } = await rpc('fail_solidgate_subscription_token_sync', {
    p_payment_environment: job.payment_environment,
    p_user_id: job.user_id,
    p_solidgate_subscription_id: job.solidgate_subscription_id,
    p_claim_token: job.claim_token,
    p_desired_source_kind: state.desired_source_kind,
    p_desired_source_id: state.desired_source_id,
    p_last_error: message,
  });
  if (error) throw new Error(`subscription-token sync failure persistence failed: ${error.message}`);
  return data === true;
}

/**
 * Applies one leased subscription job. A newer vault generation can arrive
 * during the provider request; exact-generation completion then fails and this
 * same lease loops to the new token. A five-minute lease exceeds both the
 * provider's 12-second request deadline and the serverless invocation ceiling,
 * so a reclaimed worker cannot overlap a still-live old request in practice.
 */
export async function processSubscriptionTokenSyncJob(params: {
  supabase: SupabaseClient;
  client: Pick<SolidgateClient, 'updateSubscriptionToken'>;
  job: SubscriptionTokenSyncJob;
}): Promise<'completed' | 'failed' | 'lost'> {
  const rpc = params.supabase.rpc.bind(params.supabase) as unknown as RpcClient;
  for (let generation = 0; generation < 16; generation += 1) {
    const state = await readClaimedState(rpc, params.job);
    if (!state) return 'lost';

    if (!state.subscription_is_billable) {
      // The SQL completion rechecks exact order/entitlement billability in the
      // same UPDATE. If billability is already restored, completion returns
      // false and this lease loops to apply the token at the provider. Durable
      // canceled/revoked lifecycle tombstones prevent later reactivation of a
      // subscription after a successful obsolete completion.
      if (await completeExactGeneration(rpc, params.job, state, true)) return 'completed';
      continue;
    }

    try {
      const response = await params.client.updateSubscriptionToken({
        subscription_id: params.job.solidgate_subscription_id,
        token: state.card_token,
      });
      const responseError = providerError(response);
      if (responseError) throw new Error(responseError);
    } catch (cause) {
      // If the desired source changed while this request was in flight, do not
      // fail the new generation. Loop and immediately repair with its token.
      if (!await failExactGeneration(rpc, params.job, state, cause)) continue;
      return 'failed';
    }

    if (await completeExactGeneration(rpc, params.job, state)) return 'completed';
  }

  const latest = await readClaimedState(rpc, params.job);
  if (!latest) return 'lost';
  if (await failExactGeneration(
    rpc,
    params.job,
    latest,
    new Error('subscription token source changed too many times during one lease'),
  )) return 'failed';
  return 'lost';
}

export async function drainSolidgateSubscriptionTokenSync(params?: {
  supabase?: SupabaseClient;
  client?: Pick<SolidgateClient, 'updateSubscriptionToken'>;
  paymentEnvironment?: PaymentEnvironment;
  userId?: string;
  limit?: number;
}): Promise<{ claimed: number; completed: number; failed: number; lost: number }> {
  const supabase = params?.supabase ?? getSupabaseAdminClient();
  const paymentEnvironment = params?.paymentEnvironment ?? (
    process.env.VERCEL_ENV === 'production' ? 'production' : 'sandbox'
  );
  const client = params?.client ?? new SolidgateClient(getSolidgateKeys());
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcClient;
  const { data, error } = await rpc('claim_solidgate_subscription_token_sync', {
    p_payment_environment: paymentEnvironment,
    p_limit: params?.limit ?? 5,
    p_lease_seconds: 300,
    p_user_id: params?.userId ?? null,
  });
  if (error) throw new Error(`subscription-token sync claim failed: ${error.message}`);

  const jobs = rows(data)
    .filter((row) => (
      row.payment_environment === paymentEnvironment &&
      typeof row.user_id === 'string' &&
      typeof row.solidgate_subscription_id === 'string' &&
      typeof row.claim_token === 'string'
    ))
    .map((row) => row as unknown as SubscriptionTokenSyncJob);
  const results = await Promise.all(jobs.map(async (job) => {
    try {
      return await processSubscriptionTokenSyncJob({ supabase, client, job });
    } catch (cause) {
      console.error(
        '[solidgate/subscription-token-sync] job failed unexpectedly:',
        cause instanceof Error ? cause.message : String(cause),
      );
      return 'failed' as const;
    }
  }));

  return {
    claimed: jobs.length,
    completed: results.filter((result) => result === 'completed').length,
    failed: results.filter((result) => result === 'failed').length,
    lost: results.filter((result) => result === 'lost').length,
  };
}
