import { describe, expect, it } from 'vitest';
import {
  orderFingerprint,
  providerEvidence,
  providerThrottleMs,
  type LegacyOrder,
  type ProviderStatus,
  validateOperatorDatabaseUrl,
} from './solidgate-reconciliation-evidence';

const metadata = {
  funnel_code: 'BRAND',
  funnel_variant: 'main',
  session_id: '11111111-1111-4111-8111-111111111111',
  product_slug: 'trial1',
  price_id: 'provider-price-1',
};

const order: LegacyOrder = {
  id: 'db-order',
  solidgate_order_id: `${metadata.session_id}:trial1:1`,
  session_id: metadata.session_id,
  user_id: null,
  product_name: 'BRAND_000000_SUB',
  amount_cents: 500,
  currency: 'usd',
  solidgate_original_amount_cents: 500,
  tracking_metadata: metadata,
};

function authorization(id = 'auth-1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'success',
    operation: 'auth',
    amount: 500,
    currency: 'USD',
    card_token: { token: 'exact-card-token' },
    card: { brand: 'VISA', number: '411111XXXXXX4242' },
    ...overrides,
  };
}

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    order: {
      order_id: order.solidgate_order_id,
      customer_email: 'buyer@example.test',
      customer_account_id: order.session_id!,
      order_description: 'EN_BRAND_000000_SUB',
      amount: 500,
      currency: 'USD',
      product_id: metadata.price_id,
    },
    order_metadata: metadata,
    transactions: { 'auth-1': authorization() },
    ...overrides,
  };
}

describe('Solidgate legacy reconciliation provider evidence', () => {
  it('returns exact order/product/card evidence from one canonical authorization', () => {
    expect(providerEvidence(order, status())).toEqual({
      email: 'buyer@example.test',
      accountId: order.session_id,
      description: 'EN_BRAND_000000_SUB',
      productId: metadata.price_id,
      amountCents: 500,
      currency: 'USD',
      orderMetadata: metadata,
      cardToken: 'exact-card-token',
      cardBrand: 'VISA',
      cardLast4: '4242',
    });
  });

  it('rejects a provider product that differs from immutable metadata price_id', () => {
    const provider = status();
    provider.order = { ...provider.order, product_id: 'different-price' };

    expect(providerEvidence(order, provider)).toBeNull();
  });

  it.each([
    [
      'map key/id mismatch',
      { transactions: { unexpected: authorization('auth-1') } },
    ],
    [
      'direct/nested token conflict',
      {
        transaction: authorization('auth-1', {
          card: {
            brand: 'VISA',
            number: '411111XXXXXX4242',
            card_token: { token: 'different-token' },
          },
        }),
        transactions: {},
      },
    ],
    [
      'duplicate card conflict',
      {
        transaction: authorization('auth-1'),
        transactions: {
          'auth-1': authorization('auth-1', {
            card: { brand: 'MASTERCARD', number: '411111XXXXXX4242' },
          }),
        },
      },
    ],
    [
      'multiple exact authorization tokens',
      {
        transactions: {
          'auth-1': authorization('auth-1'),
          'auth-2': authorization('auth-2', {
            card_token: { token: 'second-token' },
          }),
        },
      },
    ],
  ])('rejects ambiguous %s', async (_case, transactionShape) => {
    expect(providerEvidence(order, status(transactionShape))).toBeNull();
  });

  it.each([
    ['settlement operation', { operation: 'settle' }],
    ['wrong amount', { amount: 499 }],
    ['wrong currency', { currency: 'EUR' }],
  ])('keeps order evidence but omits card evidence for %s', (_case, transactionPatch) => {
    const evidence = providerEvidence(order, status({
      transactions: { 'auth-1': authorization('auth-1', transactionPatch) },
    }));

    expect(evidence).not.toBeNull();
    expect(evidence).toMatchObject({
      cardToken: null,
      cardBrand: null,
      cardLast4: null,
    });
  });
});

describe('Solidgate reconciliation operator database URL', () => {
  const projectUrl = 'https://projectref.supabase.co';

  it.each([
    'https://postgres:secret@db.projectref.supabase.co/postgres',
    'postgresql://app:secret@db.projectref.supabase.co/postgres',
    'postgresql://postgres.projectref:secret@attacker.example/postgres?sslmode=require',
    'postgresql://postgres:secret@db.otherref.supabase.co/postgres?sslmode=require',
    'postgresql://postgres.projectref:secret@aws-0-eu-west-1.pooler.supabase.com/postgres?sslmode=disable',
  ])('rejects a non-owner, foreign, or insecure URL: %s', (databaseUrl) => {
    expect(() => validateOperatorDatabaseUrl(databaseUrl, projectUrl)).toThrow();
  });

  it.each([
    'postgresql://postgres:secret@db.projectref.supabase.co/postgres?sslmode=require',
    'postgresql://postgres.projectref:secret@aws-0-eu-west-1.pooler.supabase.com/postgres?sslmode=verify-full',
  ])('accepts an exact project owner connection: %s', (databaseUrl) => {
    expect(validateOperatorDatabaseUrl(databaseUrl, projectUrl)).toBeInstanceOf(URL);
  });

  it('allows disabled TLS only for a self-hosted local database', () => {
    expect(validateOperatorDatabaseUrl(
      'postgresql://postgres@localhost:5432/postgres?sslmode=disable',
      'http://localhost:54321',
    )).toBeInstanceOf(URL);
  });
});

describe('Solidgate reconciliation log identity', () => {
  it('uses a stable short digest without exposing the order/session identifier', () => {
    const orderId = '11111111-1111-4111-8111-111111111111:trial1:1';
    const fingerprint = orderFingerprint(orderId);

    expect(fingerprint).toMatch(/^order-[0-9a-f]{16}$/);
    expect(orderFingerprint(orderId)).toBe(fingerprint);
    expect(fingerprint).not.toContain('11111111');
    expect(fingerprint).not.toContain('trial1');
  });

  it('stays below each provider environment rate limit', () => {
    expect(providerThrottleMs('sandbox')).toBeGreaterThan(100);
    expect(providerThrottleMs('production')).toBeGreaterThanOrEqual(40);
  });
});
