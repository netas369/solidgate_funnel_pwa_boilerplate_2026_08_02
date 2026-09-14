import { describe, expect, it, vi } from 'vitest';
import { persistSolidgatePartialCapture } from '../solidgate/partial-capture';

const input = { environment: 'production' as const, orderDbId: '11111111-1111-4111-8111-111111111111',
  orderId: 'merchant:offer:1', quotedAmountCents: 1767, capturedAmountCents: 1200,
  currency: 'USD', providerStatus: 'partial_settled', sessionId: 'session-1' };
const db = () => ({ rpc: vi.fn().mockResolvedValue({ data: { net_amount_cents: 1200 }, error: null }) });

describe('verified partial capture persistence', () => {
  it('records actual capture and an atomic receipt without changing the quoted price or granting access', async () => {
    const client = db();
    expect(await persistSolidgatePartialCapture(client as never, input)).toBe(true);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('apply_solidgate_financial_event', expect.objectContaining({
      p_facts: { order_db_id: input.orderDbId, currency: 'usd', quoted_amount_cents: 1767,
        captured_amount_cents: 1200, payment_status: 'partial_settled', occurred_at_source: 'received_at' },
      p_analytics: expect.objectContaining({ event_key: 'order:merchant:offer:1:captured:1200', event_name: 'payment_captured' }),
    }));
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN, 1767, 1768])('does not infer undercapture from %s', async (capturedAmountCents) => {
    const client = db();
    expect(await persistSolidgatePartialCapture(client as never, { ...input, capturedAmountCents })).toBe(false);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('does not treat authorization as capture', async () => {
    const client = db();
    expect(await persistSolidgatePartialCapture(client as never, { ...input, providerStatus: 'auth_ok' })).toBe(false);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('reuses a deterministic operation and outbox ID on status polling', async () => {
    const client = db();
    await persistSolidgatePartialCapture(client as never, input);
    await persistSolidgatePartialCapture(client as never, input);
    expect(client.rpc.mock.calls[0]).toEqual(client.rpc.mock.calls[1]);
  });

  it('preserves sandbox finance with no production analytics', async () => {
    const client = db();
    await persistSolidgatePartialCapture(client as never, { ...input, environment: 'sandbox' });
    expect(client.rpc.mock.calls[0][1]).toMatchObject({ p_environment: 'sandbox', p_analytics: null });
  });

  it('propagates finance persistence failure so a later status poll retries it', async () => {
    const client = db();
    client.rpc.mockResolvedValue({ data: null, error: { message: 'transaction rolled back' } });
    await expect(persistSolidgatePartialCapture(client as never, input)).rejects.toThrow('transaction rolled back');
  });
});
