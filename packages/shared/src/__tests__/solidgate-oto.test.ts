import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolidgateClient } from '../solidgate/client';
import {
  chargeSavedCard,
  classifySolidgatePayment,
  solidgateCapturedAmount,
  subscribeSavedCard,
} from '../solidgate/oto';

describe('Solidgate payment lifecycle classification', () => {
  it('does not recognise a positive authorization before capture', () => {
    expect(
      classifySolidgatePayment(
        { status: 'auth_ok', amount: 3_000, subscription_id: 'sub-1' },
        3_000,
      ),
    ).toBe('pending');
  });

  it('recognises only a genuine zero-amount subscription trial at auth_ok', () => {
    expect(
      classifySolidgatePayment(
        { status: 'auth_ok', amount: 0, subscription_id: 'sub-trial' },
        0,
      ),
    ).toBe('success');
    expect(classifySolidgatePayment({ status: 'auth_ok', amount: 0 }, 0)).toBe('pending');
    expect(
      classifySolidgatePayment(
        { status: 'auth_ok', amount: 100, subscription_id: 'sub-not-free' },
        0,
      ),
    ).toBe('pending');
  });

  it('keeps an under-captured partial_settled order pending on the same identity', () => {
    expect(
      classifySolidgatePayment(
        { status: 'partial_settled', amount: 3_000, settled_amount: 2_999 },
        3_000,
      ),
    ).toBe('pending');
    expect(
      classifySolidgatePayment({ status: 'partial_settled', amount: 3_000 }, 3_000),
    ).toBe('pending');
    expect(
      classifySolidgatePayment(
        { status: 'partial_settled', amount: 3_000, settled_amount: 3_000 },
        3_000,
      ),
    ).toBe('success');
    expect(
      classifySolidgatePayment(
        { status: 'partial_settled', amount: 3_000, settled_amount: 3_001 },
        3_000,
      ),
    ).toBe('pending');
  });

  it('keeps processing and 3DS orders pending when settled_amount is zero', () => {
    expect(
      classifySolidgatePayment(
        { status: 'processing', amount: 3_000, settled_amount: 0 },
        3_000,
      ),
    ).toBe('pending');
    expect(
      classifySolidgatePayment(
        { status: '3ds_verify', amount: 3_000, settled_amount: 0 },
        3_000,
      ),
    ).toBe('pending');
  });

  it('treats capture as paid and void as an explicit terminal result', () => {
    expect(classifySolidgatePayment({ status: 'settle_ok', amount: 3_000 }, 3_000)).toBe(
      'success',
    );
    expect(classifySolidgatePayment({ status: 'void_ok', amount: 3_000 }, 3_000)).toBe(
      'voided',
    );
    expect(classifySolidgatePayment({ status: 'auth_failed', amount: 3_000 }, 3_000)).toBe(
      'failed',
    );
  });

  it('does not treat the APM-only approved status as a card capture', () => {
    expect(classifySolidgatePayment({ status: 'approved', amount: 3_000 }, 3_000)).toBe('failed');
  });

  it('derives exact partial capture from real card transaction fields without double counting', () => {
    const settle = {
      id: 'settle-1',
      operation: 'settle',
      status: 'success',
      amount: 3_000,
      currency: 'EUR',
    };
    expect(solidgateCapturedAmount({
      order: { status: 'partial_settled', amount: 3_000, currency: 'EUR' },
      transaction: settle,
      transactions: { 'settle-1': settle },
    }, 3_000)).toBe(3_000);
    expect(solidgateCapturedAmount({
      order: { status: 'partial_settled', amount: 3_000, currency: 'EUR' },
      transactions: {
        'settle-1': { ...settle, amount: 2_999 },
      },
    }, 3_000)).toBe(2_999);
    expect(solidgateCapturedAmount({
      order: { status: 'partial_settled', amount: 3_000, currency: 'EUR' },
      transactions: {
        'settle-1': { ...settle, currency: 'USD' },
      },
    }, 3_000)).toBeNull();
  });
});

describe('saved-card charge settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns failed with the real error when Solidgate refuses the request outright', async () => {
    // Regression (2026-07-17): a 2.01 validation refusal has no `order` object;
    // `!status` used to classify it as 'pending', swallowing the error and
    // leaving the DB order stuck pending forever.
    const client = {
      recurring: vi.fn().mockResolvedValue({
        error: {
          code: '2.01',
          messages: { success_url: ['This value is not a valid URL.'] },
        },
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto1_lifetime:1',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 9_900,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      providerStatus: 'request_rejected',
      errorCode: '2.01',
      errorMessage: 'This value is not a valid URL.',
    });
    // A refusal is terminal — no point polling a nonexistent order.
    expect(client.status).not.toHaveBeenCalled();
  });

  it('marks a rejected request with conflicting challenge aliases as contradictory', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        verify_url: 'https://acs.example/canonical',
        verify_link: 'https://acs.example/conflicting-alias',
        error: { code: '2.01', messages: ['Invalid request'] },
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto1_lifetime:conflicting-rejection',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 9_900,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      providerStatus: 'request_rejected',
      verifyUrlConflict: true,
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it('preserves auth_failed as terminal provider evidence for safe order retirement', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:1',
          customer_account_id: 'customer',
          status: 'auth_failed',
          amount: 3_000,
          currency: 'EUR',
        },
        error: {
          code: '3.02',
          recommended_message_for_user: 'Payment declined',
        },
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3_bundle_all:1',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      providerOrderId: 'session:oto3_bundle_all:1',
      customerAccountId: 'customer',
      providerStatus: 'auth_failed',
      orderAmount: 3_000,
      currency: 'EUR',
      errorCode: '3.02',
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it('does not resurrect a terminal failure from a stale verification URL', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:stale-3ds',
          customer_account_id: 'customer',
          status: 'auth_failed',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_url: 'https://acs.example/stale',
        error: { code: '3.02', recommended_message_for_user: 'Payment declined' },
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3_bundle_all:stale-3ds',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
        settlement: { attempts: 0 },
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      providerStatus: 'auth_failed',
      errorCode: '3.02',
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it('returns a current processing verification challenge as actionable', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:current-3ds',
          customer_account_id: 'customer',
          status: 'processing',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_url: 'https://acs.example/current',
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3_bundle_all:current-3ds',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
        settlement: { attempts: 0 },
      }),
    ).resolves.toMatchObject({
      status: 'requires_action',
      providerStatus: 'processing',
      verifyUrl: 'https://acs.example/current',
    });
  });

  it('submits wallet-token upsells as rebill and accepts the Support verify_link alias', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:wallet',
          customer_account_id: 'customer',
          status: '3ds_verify',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_link: 'https://acs.example/wallet',
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3_bundle_all:wallet',
        recurringToken: 'wallet-token',
        paymentType: 'rebill',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
        headerAccept: 'application/json, */*',
        userAgent: 'Mozilla/5.0 (UAT probe)',
        settlement: { attempts: 0 },
      }),
    ).resolves.toMatchObject({
      status: 'requires_action',
      verifyUrl: 'https://acs.example/wallet',
    });
    expect(client.recurring).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_type: 'rebill',
        recurring_token: 'wallet-token',
        // 3DS 2.0 browser data forwarded for the frictionless flow.
        header_accept: 'application/json, */*',
        user_agent: 'Mozilla/5.0 (UAT probe)',
      }),
    );
  });

  it('does not redirect when canonical and compatibility verification URLs conflict', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:conflicting-3ds',
          customer_account_id: 'customer',
          status: '3ds_verify',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_url: 'https://acs.example/canonical',
        verify_link: 'https://acs.example/conflict',
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3_bundle_all:conflicting-3ds',
        recurringToken: 'wallet-token',
        paymentType: 'rebill',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
        settlement: { attempts: 0 },
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      providerStatus: '3ds_verify',
      verifyUrlConflict: true,
    });
  });

  it('preserves an observed alias conflict across later URL-less status polling', async () => {
    vi.useFakeTimers();
    const orderId = 'session:oto3_bundle_all:conflict-poll';
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: orderId,
          customer_account_id: 'customer',
          status: '3ds_verify',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_url: 'https://acs.example/canonical',
        verify_link: 'https://acs.example/conflicting-alias',
      }),
      status: vi.fn().mockResolvedValue({
        order: {
          order_id: orderId,
          customer_account_id: 'customer',
          status: '3ds_verify',
          amount: 3_000,
          currency: 'EUR',
        },
      }),
    } as unknown as SolidgateClient;

    const resultPromise = chargeSavedCard(client, {
      orderId,
      recurringToken: 'wallet-token',
      paymentType: 'rebill',
      amount: 3_000,
      currency: 'eur',
      orderDescription: 'OTO',
      customerAccountId: 'customer',
      customerEmail: 'buyer@example.com',
      ipAddress: '203.0.113.1',
      settlement: { attempts: 1, intervalMs: 1 },
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'pending',
      providerStatus: '3ds_verify',
      verifyUrlConflict: true,
    });
  });

  it('never treats auth_ok plus a leftover verification URL as a new challenge', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:authorized',
          customer_account_id: 'customer',
          status: 'auth_ok',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_url: 'https://acs.example/already-completed',
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3_bundle_all:authorized',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
        settlement: { attempts: 0 },
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      providerStatus: 'auth_ok',
    });
  });

  it('uses only explicit 3ds_verify URLs from later status polling', async () => {
    vi.useFakeTimers();
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:status-stale',
          customer_account_id: 'customer',
          status: 'auth_ok',
          amount: 3_000,
          currency: 'EUR',
        },
      }),
      status: vi.fn().mockResolvedValue({
        order: {
          order_id: 'session:oto3_bundle_all:status-stale',
          customer_account_id: 'customer',
          status: 'processing',
          amount: 3_000,
          currency: 'EUR',
        },
        verify_url: 'https://acs.example/stale-status-url',
      }),
    } as unknown as SolidgateClient;

    const resultPromise = chargeSavedCard(client, {
      orderId: 'session:oto3_bundle_all:status-stale',
      recurringToken: 'token',
      paymentType: '1-click',
      amount: 3_000,
      currency: 'eur',
      orderDescription: 'OTO',
      customerAccountId: 'customer',
      customerEmail: 'buyer@example.com',
      ipAddress: '203.0.113.1',
      settlement: { attempts: 1, intervalMs: 1 },
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'pending',
      providerStatus: 'processing',
    });
  });

  it('polls a positive auth_ok until schema-faithful settle_ok before returning success', async () => {
    vi.useFakeTimers();
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: { status: 'auth_ok', amount: 3_000, currency: 'EUR' },
      }),
      status: vi.fn().mockResolvedValue({
        // Faithful to ResponseCardsStatus: no order.settled_amount.
        order: { status: 'settle_ok', amount: 3_000, currency: 'EUR' },
      }),
    } as unknown as SolidgateClient;

    const resultPromise = chargeSavedCard(client, {
      orderId: 'session:oto3:1',
      recurringToken: 'token',
      paymentType: '1-click',
      amount: 3_000,
      currency: 'eur',
      orderDescription: 'OTO',
      customerAccountId: 'customer',
      customerEmail: 'buyer@example.com',
      ipAddress: '203.0.113.1',
      successUrl: 'https://funnel.example.com/lt/oto/3?sg_confirm=session%3Aoto3%3A1',
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({
      status: 'success',
      amount: 3_000,
      settledAmount: 3_000,
      currency: 'EUR',
    });
    expect(client.status).toHaveBeenCalledTimes(1);
    expect(client.recurring).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: 'https://funnel.example.com/lt/oto/3?sg_confirm=session%3Aoto3%3A1',
        fail_url: 'https://funnel.example.com/lt/oto/3?sg_confirm=session%3Aoto3%3A1',
      }),
    );
  });

  it('never upgrades a positive auth_ok to success when capture does not arrive', async () => {
    vi.useFakeTimers();
    const authorized = {
      order: { status: 'auth_ok', amount: 3_000, currency: 'EUR' },
    };
    const client = {
      recurring: vi.fn().mockResolvedValue(authorized),
      status: vi.fn().mockResolvedValue(authorized),
    } as unknown as SolidgateClient;

    const resultPromise = chargeSavedCard(client, {
      orderId: 'session:oto3:pending',
      recurringToken: 'token',
      paymentType: '1-click',
      amount: 3_000,
      currency: 'eur',
      orderDescription: 'OTO',
      customerAccountId: 'customer',
      customerEmail: 'buyer@example.com',
      ipAddress: '203.0.113.1',
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({ status: 'pending' });
    expect(client.status).toHaveBeenCalledTimes(8);
  });

  it('accepts a zero-value subscription trial without waiting for capture', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: {
          status: 'auth_ok',
          amount: 0,
          currency: 'EUR',
          subscription_id: 'sub-trial',
        },
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      subscribeSavedCard(client, {
        orderId: 'session:addon:1',
        recurringToken: 'token',
        paymentType: 'rebill',
        productId: 'product-trial',
        expectedAmount: 0,
        currency: 'eur',
        orderDescription: 'Add-on trial',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
        successUrl: 'https://funnel.example.com/lt/oto/2?sg_confirm=session%3Aaddon%3A1',
      }),
    ).resolves.toMatchObject({
      status: 'success',
      subscriptionId: 'sub-trial',
      amount: 0,
    });
    expect(client.status).not.toHaveBeenCalled();
    expect(client.recurring).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_type: 'rebill',
        success_url: 'https://funnel.example.com/lt/oto/2?sg_confirm=session%3Aaddon%3A1',
        fail_url: 'https://funnel.example.com/lt/oto/2?sg_confirm=session%3Aaddon%3A1',
      }),
    );
  });

  it('returns void_ok as voided, never success', async () => {
    const client = {
      recurring: vi.fn().mockResolvedValue({
        order: { status: 'void_ok', amount: 3_000, currency: 'EUR' },
      }),
      status: vi.fn(),
    } as unknown as SolidgateClient;

    await expect(
      chargeSavedCard(client, {
        orderId: 'session:oto3:2',
        recurringToken: 'token',
        paymentType: '1-click',
        amount: 3_000,
        currency: 'eur',
        orderDescription: 'OTO',
        customerAccountId: 'customer',
        customerEmail: 'buyer@example.com',
        ipAddress: '203.0.113.1',
      }),
    ).resolves.toMatchObject({ status: 'voided', errorCode: 'void_ok' });
  });
});
