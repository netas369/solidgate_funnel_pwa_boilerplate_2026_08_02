import { describe, expect, it, vi } from 'vitest';
import {
  parseSolidgateOriginalPaymentMethod,
  paymentTypeForOriginalPaymentMethod,
} from '../solidgate/payment-method';
import { getSessionVault, upsertSessionVault } from '../solidgate/session-vault';

function readClient(row: Record<string, unknown> | null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  return { from: vi.fn(() => chain) } as never;
}

describe('Solidgate exact-source session vault', () => {
  it('writes a token only through its captured main-order source', async () => {
    const rpc = vi.fn(async () => ({ data: 'written', error: null }));

    await upsertSessionVault({ rpc } as never, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      sourceOrderId: '22222222-2222-4222-8222-222222222222',
      customerAccountId: '11111111-1111-4111-8111-111111111111',
      paymentEnvironment: 'sandbox',
      card: {
        token: 'main-token',
        brand: 'visa',
        maskedNumber: '411111******4242',
        originalPaymentMethod: 'apple-pay',
      },
    });

    expect(rpc).toHaveBeenCalledWith('write_solidgate_session_vault_with_method', {
      p_payment_environment: 'sandbox',
      p_session_id: '11111111-1111-4111-8111-111111111111',
      p_source_order_id: '22222222-2222-4222-8222-222222222222',
      p_customer_account_id: '11111111-1111-4111-8111-111111111111',
      p_card_token: 'main-token',
      p_card_brand: 'visa',
      p_card_last4: '4242',
      p_original_payment_method: 'apple-pay',
    });
  });

  it('publishes an exact tokenless source watermark instead of returning early', async () => {
    const rpc = vi.fn(async () => ({ data: 'written', error: null }));

    await upsertSessionVault({ rpc } as never, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      sourceOrderId: '33333333-3333-4333-8333-333333333333',
      customerAccountId: '11111111-1111-4111-8111-111111111111',
      paymentEnvironment: 'production',
      card: null,
    });

    expect(rpc).toHaveBeenCalledWith('write_solidgate_session_vault_with_method', {
      p_payment_environment: 'production',
      p_session_id: '11111111-1111-4111-8111-111111111111',
      p_source_order_id: '33333333-3333-4333-8333-333333333333',
      p_customer_account_id: '11111111-1111-4111-8111-111111111111',
      p_card_token: null,
      p_card_brand: null,
      p_card_last4: null,
      p_original_payment_method: null,
    });
  });

  it('never exposes an unreconciled legacy token to the OTO chain', async () => {
    const vault = await getSessionVault(
      readClient({
        session_id: 'session-1',
        customer_account_id: 'session-1',
        card_token: 'legacy-token',
        card_brand: 'visa',
        card_last4: '4242',
        card_original_payment_method: 'card',
        card_source_order_id: null,
        card_source_legacy: true,
      }),
      'session-1',
      'production',
    );

    expect(vault).toMatchObject({
      sourceOrderId: null,
      cardToken: null,
      cardBrand: null,
      cardLast4: null,
    });
  });

  it('exposes an exact-order-bound token', async () => {
    const vault = await getSessionVault(
      readClient({
        session_id: 'session-1',
        customer_account_id: 'session-1',
        card_token: 'bound-token',
        card_brand: 'mastercard',
        card_last4: '2222',
        card_original_payment_method: 'network-token',
        card_source_order_id: '22222222-2222-4222-8222-222222222222',
        card_source_legacy: false,
      }),
      'session-1',
      'sandbox',
    );

    expect(vault).toMatchObject({
      sourceOrderId: '22222222-2222-4222-8222-222222222222',
      cardToken: 'bound-token',
      cardBrand: 'mastercard',
      cardLast4: '2222',
      cardOriginalPaymentMethod: 'network-token',
    });
  });

  it('fails closed when an exact token has no valid provider provenance', async () => {
    const vault = await getSessionVault(
      readClient({
        session_id: 'session-1',
        customer_account_id: 'session-1',
        card_token: 'unverified-token',
        card_brand: 'visa',
        card_last4: '4242',
        card_original_payment_method: 'unexpected-wallet',
        card_source_order_id: '22222222-2222-4222-8222-222222222222',
        card_source_legacy: false,
      }),
      'session-1',
      'sandbox',
    );

    expect(vault).toMatchObject({
      sourceOrderId: '22222222-2222-4222-8222-222222222222',
      cardToken: null,
      cardBrand: null,
      cardLast4: null,
      cardOriginalPaymentMethod: null,
    });
  });
});

describe('Solidgate token-origin payment type', () => {
  it.each([
    ['card', '1-click'],
    ['network-token', '1-click'],
    ['apple-pay', 'rebill'],
    ['google-pay', 'rebill'],
    ['click-to-pay', null],
    [null, null],
    ['CARD', null],
    ['unknown', null],
  ])('maps %s to %s without guessing', (method, expected) => {
    expect(paymentTypeForOriginalPaymentMethod(method)).toBe(expected);
  });

  it('parses the complete observational enum strictly', () => {
    expect(parseSolidgateOriginalPaymentMethod('click-to-pay')).toBe('click-to-pay');
    expect(parseSolidgateOriginalPaymentMethod(' click-to-pay ')).toBeNull();
  });
});
