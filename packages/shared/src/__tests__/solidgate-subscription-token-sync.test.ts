import { describe, expect, it, vi } from 'vitest';
import {
  processSubscriptionTokenSyncJob,
  type SubscriptionTokenSyncJob,
} from '../solidgate/subscription-token-sync';

const job: SubscriptionTokenSyncJob = {
  payment_environment: 'sandbox',
  user_id: '11111111-1111-4111-8111-111111111111',
  solidgate_subscription_id: 'sub-main',
  desired_source_kind: 'card_update',
  desired_source_id: '22222222-2222-4222-8222-222222222222',
  claim_token: '33333333-3333-4333-8333-333333333333',
};

type UpdateAttributes = { subscription_id: string; token: string };

function state(sourceId: string, token: string, billable = true) {
  return [{
    desired_source_kind: 'card_update',
    desired_source_created_at: '2026-07-21T12:00:00.000Z',
    desired_source_id: sourceId,
    card_token: token,
    subscription_is_billable: billable,
  }];
}

describe('Solidgate subscription token sync fencing', () => {
  it('applies and completes the exact desired vault generation', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        return { data: state(job.desired_source_id, 'token-current'), error: null };
      }
      if (name === 'complete_solidgate_subscription_token_sync') {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const updateSubscriptionToken = vi.fn(async (_attributes: UpdateAttributes) => ({}));

    const result = await processSubscriptionTokenSyncJob({
      supabase: { rpc } as never,
      client: { updateSubscriptionToken },
      job,
    });

    expect(result).toBe('completed');
    expect(updateSubscriptionToken).toHaveBeenCalledWith({
      subscription_id: 'sub-main',
      token: 'token-current',
    });
  });

  it('repairs with a newer token when the vault changes during the provider call', async () => {
    const newerId = '44444444-4444-4444-8444-444444444444';
    let reads = 0;
    let completions = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        reads += 1;
        return {
          data: reads === 1
            ? state(job.desired_source_id, 'token-old')
            : state(newerId, 'token-new'),
          error: null,
        };
      }
      if (name === 'complete_solidgate_subscription_token_sync') {
        completions += 1;
        return { data: completions === 2, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const updateSubscriptionToken = vi.fn(async (_attributes: UpdateAttributes) => ({}));

    const result = await processSubscriptionTokenSyncJob({
      supabase: { rpc } as never,
      client: { updateSubscriptionToken },
      job,
    });

    expect(result).toBe('completed');
    expect(updateSubscriptionToken.mock.calls.map(([attributes]) => attributes.token))
      .toEqual(['token-old', 'token-new']);
    expect(rpc).toHaveBeenLastCalledWith(
      'complete_solidgate_subscription_token_sync',
      expect.objectContaining({ p_desired_source_id: newerId }),
    );
  });

  it('does not fail a newer generation when the old provider request fails', async () => {
    const newerId = '55555555-5555-4555-8555-555555555555';
    let reads = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        reads += 1;
        return {
          data: reads === 1
            ? state(job.desired_source_id, 'token-old')
            : state(newerId, 'token-new'),
          error: null,
        };
      }
      if (name === 'fail_solidgate_subscription_token_sync') {
        return { data: false, error: null };
      }
      if (name === 'complete_solidgate_subscription_token_sync') {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const updateSubscriptionToken = vi
      .fn(async (_attributes: UpdateAttributes): Promise<Record<string, unknown>> => ({}))
      .mockRejectedValueOnce(new Error('lost response'));

    const result = await processSubscriptionTokenSyncJob({
      supabase: { rpc } as never,
      client: { updateSubscriptionToken },
      job,
    });

    expect(result).toBe('completed');
    expect(updateSubscriptionToken).toHaveBeenLastCalledWith({
      subscription_id: 'sub-main',
      token: 'token-new',
    });
  });

  it('persists a retryable failure for the exact current generation', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        return { data: state(job.desired_source_id, 'token-current'), error: null };
      }
      if (name === 'fail_solidgate_subscription_token_sync') {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });

    const result = await processSubscriptionTokenSyncJob({
      supabase: { rpc } as never,
      client: {
        updateSubscriptionToken: vi.fn(async (_attributes: UpdateAttributes) => {
          throw new Error('offline');
        }),
      },
      job,
    });

    expect(result).toBe('failed');
    expect(rpc).toHaveBeenCalledWith(
      'fail_solidgate_subscription_token_sync',
      expect.objectContaining({ p_last_error: 'offline' }),
    );
  });

  it('completes an obsolete subscription without touching the provider', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        return { data: state(job.desired_source_id, 'token-current', false), error: null };
      }
      if (name === 'complete_solidgate_subscription_token_sync') {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const updateSubscriptionToken = vi.fn(async (_attributes: UpdateAttributes) => ({}));

    const result = await processSubscriptionTokenSyncJob({
      supabase: { rpc } as never,
      client: { updateSubscriptionToken },
      job,
    });

    expect(result).toBe('completed');
    expect(updateSubscriptionToken).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'complete_solidgate_subscription_token_sync',
      expect.objectContaining({ p_require_nonbillable: true }),
    );
  });

  it('applies the token when billability returns during obsolete completion', async () => {
    let reads = 0;
    let completions = 0;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'read_claimed_solidgate_subscription_token_sync') {
        reads += 1;
        return {
          data: state(job.desired_source_id, 'token-current', reads > 1),
          error: null,
        };
      }
      if (name === 'complete_solidgate_subscription_token_sync') {
        completions += 1;
        if (completions === 1) {
          expect(args.p_require_nonbillable).toBe(true);
          return { data: false, error: null };
        }
        expect(args.p_require_nonbillable).toBe(false);
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    const updateSubscriptionToken = vi.fn(async (_attributes: UpdateAttributes) => ({}));

    const result = await processSubscriptionTokenSyncJob({
      supabase: { rpc } as never,
      client: { updateSubscriptionToken },
      job,
    });

    expect(result).toBe('completed');
    expect(updateSubscriptionToken).toHaveBeenCalledWith({
      subscription_id: 'sub-main',
      token: 'token-current',
    });
  });
});
