import { describe, expect, it, vi } from 'vitest';
import {
  getAccountVault,
  promoteSessionVaultToAccount,
  upsertAccountVault,
} from '../solidgate/account-vault';

function makeClient(options?: {
  existingMethod?: string | null;
  existingToken?: string | null;
  rpcResult?: unknown;
}) {
  const rpc = vi.fn(async () => ({
    data: options?.rpcResult ?? 'written',
    error: null,
  }));
  const filters: Array<{ table: string; column: string; value: unknown }> = [];

  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((column: string, value: unknown) => {
      filters.push({ table, column, value });
      return chain;
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'solidgate_session_vault') {
        return {
          data: {
            session_id: 'session-1',
            customer_account_id: 'session-1',
            card_token: 'tok-session',
            card_brand: 'VISA',
            card_last4: '4242',
            card_original_payment_method: 'card',
          },
          error: null,
        };
      }
      if (options?.existingToken) {
        return {
          data: {
            user_id: 'user-1',
            customer_account_id: 'user-1',
            card_token: options.existingToken,
            card_brand: 'MC',
            card_last4: '1111',
            card_original_payment_method:
              options.existingMethod === undefined ? 'card' : options.existingMethod,
            card_source_kind: 'main_order',
            card_source_id: '22222222-2222-4222-8222-222222222222',
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    return chain;
  });

  return { client: { from, rpc } as never, filters, rpc };
}

describe('Solidgate account vault', () => {
  it('promotes a session token under the authenticated account identity', async () => {
    const { client, rpc } = makeClient();

    await promoteSessionVaultToAccount(client, {
      userId: 'user-1',
      sessionId: 'session-1',
      paymentEnvironment: 'sandbox',
    });

    expect(rpc).toHaveBeenCalledWith('promote_solidgate_session_vault_with_method', {
      p_payment_environment: 'sandbox',
      p_user_id: 'user-1',
      p_session_id: 'session-1',
    });
  });

  it('delegates existing-token chronology to the atomic monotonic writer', async () => {
    const { client, rpc } = makeClient({
      existingToken: 'tok-existing',
      rpcResult: 'stale',
    });

    await promoteSessionVaultToAccount(client, {
      userId: 'user-1',
      sessionId: 'session-1',
      paymentEnvironment: 'production',
    });

    expect(rpc).toHaveBeenCalledOnce();
  });

  it('rejects a missing exact session watermark during promotion', async () => {
    const { client } = makeClient({ rpcResult: 'missing' });

    await expect(
      promoteSessionVaultToAccount(client, {
        userId: 'user-1',
        sessionId: 'session-1',
        paymentEnvironment: 'production',
      }),
    ).rejects.toThrow('promote session vault returned an invalid result: missing');
  });

  it('writes a hosted-form PWA card only through its captured source order', async () => {
    const { client, rpc } = makeClient();

    await upsertAccountVault(client, {
      userId: 'user-1',
      sourceOrderId: '22222222-2222-4222-8222-222222222222',
      paymentEnvironment: 'production',
      card: {
        token: 'pwa-token',
        brand: 'visa',
        maskedNumber: '411111******4242',
        originalPaymentMethod: 'google-pay',
      },
    });

    expect(rpc).toHaveBeenCalledWith('write_solidgate_account_vault_with_method', {
      p_payment_environment: 'production',
      p_user_id: 'user-1',
      p_source_kind: 'pwa_order',
      p_source_id: '22222222-2222-4222-8222-222222222222',
      p_source_claim_token: null,
      p_card_token: 'pwa-token',
      p_card_brand: 'visa',
      p_card_last4: '4242',
      p_original_payment_method: 'google-pay',
    });
  });

  it('publishes a hosted-form tokenless source watermark', async () => {
    const { client, rpc } = makeClient();

    await upsertAccountVault(client, {
      userId: 'user-1',
      sourceOrderId: '33333333-3333-4333-8333-333333333333',
      paymentEnvironment: 'sandbox',
      card: { token: null, brand: null, maskedNumber: null },
    });

    expect(rpc).toHaveBeenCalledWith('write_solidgate_account_vault_with_method', {
      p_payment_environment: 'sandbox',
      p_user_id: 'user-1',
      p_source_kind: 'pwa_order',
      p_source_id: '33333333-3333-4333-8333-333333333333',
      p_source_claim_token: null,
      p_card_token: null,
      p_card_brand: null,
      p_card_last4: null,
      p_original_payment_method: null,
    });
  });

  it('scopes account reads to the requested payment environment', async () => {
    const { client, filters } = makeClient({ existingToken: 'tok-existing' });

    await getAccountVault(client, 'user-1', 'sandbox');

    expect(filters).toContainEqual({
      table: 'solidgate_account_vault',
      column: 'payment_environment',
      value: 'sandbox',
    });
  });

  it('returns provenance only with an exact source-bound token', async () => {
    const { client } = makeClient({
      existingToken: 'tok-wallet',
      existingMethod: 'apple-pay',
    });

    const vault = await getAccountVault(client, 'user-1', 'sandbox');

    expect(vault).toMatchObject({
      cardToken: 'tok-wallet',
      cardBrand: 'MC',
      cardLast4: '1111',
      cardOriginalPaymentMethod: 'apple-pay',
    });
  });

  it('fails closed for a token with missing provenance', async () => {
    const { client } = makeClient({
      existingToken: 'tok-unverified',
      existingMethod: null,
    });

    const vault = await getAccountVault(client, 'user-1', 'production');

    expect(vault).toMatchObject({
      cardToken: null,
      cardBrand: null,
      cardLast4: null,
      cardOriginalPaymentMethod: null,
    });
  });
});
