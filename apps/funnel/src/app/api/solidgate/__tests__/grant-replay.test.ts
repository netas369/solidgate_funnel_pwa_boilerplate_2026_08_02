import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  orderMaybeSingle: vi.fn(),
  entitlementMaybeSingle: vi.fn(),
  provisionPurchasedAccount: vi.fn(),
  enqueueMainPurchaseEnrichment: vi.fn(),
  drainSolidgateFulfillmentOutbox: vi.fn(),
  after: vi.fn(),
  eq: vi.fn(),
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: mocks.after };
});

function query(maybeSingle: ReturnType<typeof vi.fn>) {
  const chain = {
    select: vi.fn(),
    eq: mocks.eq,
    maybeSingle,
  };
  chain.select.mockReturnValue(chain);
  mocks.eq.mockReturnValue(chain);
  return chain;
}

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table === 'orders') return query(mocks.orderMaybeSingle);
      if (table === 'entitlements') return query(mocks.entitlementMaybeSingle);
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock('@repo/shared/solidgate', async () => {
  const actual = await vi.importActual<typeof import('@repo/shared/solidgate')>('@repo/shared/solidgate');
  return {
    ...actual,
    SolidgateClient: class { status = mocks.status; },
    getSolidgateKeys: () => ({ publicKey: 'pk', secretKey: 'sk' }),
  };
});

vi.mock('@repo/shared/solidgate/session-vault', () => ({
  upsertSessionVault: vi.fn(),
}));

vi.mock('@repo/shared/solidgate/account-vault', () => ({
  promoteSessionVaultToAccount: vi.fn(),
}));

vi.mock('@/lib/payment/provision-account', () => ({
  linkAuthUser: vi.fn(),
  provisionPurchasedAccount: mocks.provisionPurchasedAccount,
}));
vi.mock('@/lib/payment/solidgate-fulfillment', () => ({
  enqueueMainPurchaseEnrichment: mocks.enqueueMainPurchaseEnrichment,
  drainSolidgateFulfillmentOutbox: mocks.drainSolidgateFulfillmentOutbox,
}));

const { POST } = await import('../grant/route');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = `${SESSION_ID}:trial3:1`;

function request() {
  return new Request('http://localhost/api/solidgate/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: ORDER_ID, sessionId: SESSION_ID }),
  });
}

describe('Solidgate funnel grant replay guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_ENV;
    mocks.entitlementMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('does not replay a previously settled grant after subscription cancellation', async () => {
    mocks.orderMaybeSingle.mockResolvedValue({
      data: {
        id: 'db-order-1',
        session_id: SESSION_ID,
        user_id: null,
        psp: 'solidgate',
        product_name: 'BRAND_000000_SUB',
        product_slug: 'BRAND_000000_SUB',
        amount_cents: 1300,
        currency: 'eur',
        status: 'canceled',
        created_at: '2026-07-16T08:50:00.000Z',
        tracking_metadata: {
          funnel_code: 'BRAND',
          funnel_variant: 'main',
          session_id: SESSION_ID,
          product_slug: 'trial3',
          price_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
        },
        solidgate_payment_status: 'settle_ok',
        solidgate_original_amount_cents: 1300,
        solidgate_refunded_amount_cents: 0,
        solidgate_chargeback_id: null,
        solidgate_chargeback_status: null,
        solidgate_chargeback_amount_cents: 0,
        solidgate_customer_email: 'buyer@example.com',
        solidgate_checkout_locale: 'lt',
        solidgate_product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
        solidgate_payment_action: 'auth_settle',
        solidgate_checkout_identity_legacy: false,
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'grant_revoked' });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.provisionPurchasedAccount).not.toHaveBeenCalled();
    expect(mocks.enqueueMainPurchaseEnrichment).not.toHaveBeenCalled();
    expect(mocks.eq).toHaveBeenCalledWith('payment_environment', 'sandbox');
  });
});
