import { describe, expect, it, vi } from 'vitest';
import {
  promoteSessionVaultToAccount,
  upsertAccountVault,
} from '../solidgate/account-vault';
import { upsertSessionVault } from '../solidgate/session-vault';
import {
  drainSolidgateSubscriptionTokenSync,
  processSubscriptionTokenSyncJob,
  type SubscriptionTokenSyncJob,
} from '../solidgate/subscription-token-sync';

type RpcResult = { data: unknown; error: { message: string } | null };
type RpcImplementation = (
  name: string,
  args: Record<string, unknown>,
) => Promise<RpcResult>;

/**
 * Mirrors the runtime Supabase client: rpc delegates through instance state.
 * An extracted, unbound rpc method therefore throws instead of letting an
 * arrow-function mock hide a lost `this` context.
 */
function contextBoundClient(implementation: RpcImplementation) {
  const rest = vi.fn(implementation);
  const client = {
    rest,
    rpc(
      this: { rest: typeof rest },
      name: string,
      args: Record<string, unknown>,
    ) {
      return this.rest(name, args);
    },
  };
  return { client: client as never, rest };
}

const syncJob: SubscriptionTokenSyncJob = {
  payment_environment: 'sandbox',
  user_id: '11111111-1111-4111-8111-111111111111',
  solidgate_subscription_id: 'subscription-1',
  desired_source_kind: 'card_update',
  desired_source_id: '22222222-2222-4222-8222-222222222222',
  claim_token: '33333333-3333-4333-8333-333333333333',
};

describe('Solidgate Supabase RPC client binding', () => {
  it('preserves client context for session and account vault writers', async () => {
    const { client, rest } = contextBoundClient(async () => ({
      data: 'written',
      error: null,
    }));

    await upsertSessionVault(client, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      sourceOrderId: '44444444-4444-4444-8444-444444444444',
      customerAccountId: '11111111-1111-4111-8111-111111111111',
      paymentEnvironment: 'sandbox',
      card: { token: 'session-token', originalPaymentMethod: 'card' },
    });
    await upsertAccountVault(client, {
      userId: '11111111-1111-4111-8111-111111111111',
      sourceOrderId: '55555555-5555-4555-8555-555555555555',
      paymentEnvironment: 'sandbox',
      card: { token: 'account-token', originalPaymentMethod: 'card' },
    });
    await promoteSessionVaultToAccount(client, {
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '11111111-1111-4111-8111-111111111111',
      paymentEnvironment: 'sandbox',
    });

    expect(rest.mock.calls.map(([name]) => name)).toEqual([
      'write_solidgate_session_vault_with_method',
      'write_solidgate_account_vault_with_method',
      'promote_solidgate_session_vault_with_method',
    ]);
  });

  it('preserves client context while processing a subscription sync job', async () => {
    const { client, rest } = contextBoundClient(async (name) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        return {
          data: [{
            desired_source_kind: 'card_update',
            desired_source_id: syncJob.desired_source_id,
            card_token: 'current-token',
            subscription_is_billable: true,
          }],
          error: null,
        };
      }
      if (name === 'complete_solidgate_subscription_token_sync') {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const updateSubscriptionToken = vi.fn(async () => ({}));

    await expect(processSubscriptionTokenSyncJob({
      supabase: client,
      client: { updateSubscriptionToken },
      job: syncJob,
    })).resolves.toBe('completed');

    expect(rest.mock.calls.map(([name]) => name)).toEqual([
      'read_claimed_solidgate_subscription_token_sync',
      'complete_solidgate_subscription_token_sync',
    ]);
  });

  it('preserves client context while claiming subscription sync jobs', async () => {
    const { client, rest } = contextBoundClient(async (name) => {
      if (name === 'claim_solidgate_subscription_token_sync') {
        return { data: [], error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    await expect(drainSolidgateSubscriptionTokenSync({
      supabase: client,
      client: { updateSubscriptionToken: vi.fn(async () => ({})) },
      paymentEnvironment: 'sandbox',
    })).resolves.toEqual({ claimed: 0, completed: 0, failed: 0, lost: 0 });

    expect(rest).toHaveBeenCalledWith('claim_solidgate_subscription_token_sync', {
      p_payment_environment: 'sandbox',
      p_limit: 5,
      p_lease_seconds: 300,
      p_user_id: null,
    });
  });
});
