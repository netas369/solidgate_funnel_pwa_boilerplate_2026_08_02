import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ card: vi.fn(), fulfillment: vi.fn(), token: vi.fn() }));
vi.mock('@repo/shared/solidgate/card-update-recovery', () => ({ drainSolidgateCardUpdates: mocks.card }));
vi.mock('@repo/shared/solidgate/subscription-token-sync', () => ({ drainSolidgateSubscriptionTokenSync: mocks.token }));
vi.mock('@/lib/payment/solidgate-fulfillment', () => ({ drainSolidgateFulfillmentOutbox: mocks.fulfillment }));
import { GET, POST } from './route';
const endpoint = 'https://funnel.example.com/api/internal/solidgate-fulfillment';
function cron() { return new Request(endpoint, { headers: { authorization: 'Bearer cron-secret' } }); }

describe('Solidgate internal recovery orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('INTERNAL_API_SECRET', 'internal-secret');
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.com');
    vi.stubEnv('SOLIDGATE_WEBHOOK_RECOVERY_URL', '');
    mocks.card.mockResolvedValue({ checked: 1, completed: 1, pending: 0, failed: 0 });
    mocks.fulfillment.mockResolvedValue({ claimed: 1, completed: 1, failed: 0 });
    mocks.token.mockResolvedValue({ claimed: 1, completed: 1, failed: 0, lost: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ environment: 'production', failed: 0 })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('requires a configured matching secret before any queue or provider work', async () => {
    expect((await GET(new Request(endpoint))).status).toBe(401);
    expect((await POST(new Request(endpoint, { headers: { 'x-internal-secret': 'wrong' } }))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.card).not.toHaveBeenCalled();
    expect(mocks.fulfillment).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it('does not recursively replay webhooks or card sweeps on the webhook-triggered POST', async () => {
    const response = await POST(new Request(endpoint, { method: 'POST', headers: { 'x-internal-secret': 'internal-secret' } }));
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.card).not.toHaveBeenCalled();
    expect(mocks.fulfillment).toHaveBeenCalledOnce();
    expect(mocks.token).toHaveBeenCalledOnce();
  });
  it('pins recovery to the current environment and rejects redirects', async () => {
    const response = await GET(cron());
    expect((await response.clone().json()).errors).toEqual([]);
    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://db.example.com/functions/v1/solidgate-webhooks');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-solidgate-recovery': '1', authorization: 'Bearer internal-secret' } });
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'recover', expected_environment: 'production', limit: 25 });
    expect(mocks.card).toHaveBeenCalledWith({ paymentEnvironment: 'production', limit: 10 });
  });
  it('awaits card recovery before subscription-token synchronization', async () => {
    let completeCard!: (value: unknown) => void;
    mocks.card.mockImplementation(() => new Promise(resolve => { completeCard = resolve; }));
    const response = GET(cron());
    await Promise.resolve();
    expect(mocks.token).not.toHaveBeenCalled();
    completeCard({ checked: 1, completed: 1, pending: 0, failed: 0 });
    expect((await response).status).toBe(200);
    expect(mocks.token).toHaveBeenCalledOnce();
  });
  it.each(['outage', 'wrong_environment'])('continues independent drains after webhook %s and reports failure', async (failure) => {
    if (failure === 'outage') vi.mocked(fetch).mockRejectedValue(new Error('edge unavailable'));
    else vi.mocked(fetch).mockResolvedValue(Response.json({ environment: 'sandbox', failed: 0 }));
    const response = await GET(cron());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(mocks.fulfillment).toHaveBeenCalledOnce();
    expect(mocks.token).toHaveBeenCalledOnce();
  });
  it.each(['card', 'fulfillment', 'token'] as const)('surfaces %s job failures instead of claiming a successful sweep', async (queue) => {
    mocks[queue].mockResolvedValue({ failed: 1 });
    const response = await GET(cron());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mocks.fulfillment).toHaveBeenCalledOnce();
    expect(mocks.token).toHaveBeenCalledOnce();
  });
  it('preserves token synchronization even when the card recovery RPC is unavailable', async () => {
    mocks.card.mockRejectedValue(new Error('rpc unavailable'));
    expect((await GET(cron())).status).toBe(503);
    expect(mocks.token).toHaveBeenCalledOnce();
    expect(mocks.fulfillment).toHaveBeenCalledOnce();
  });
});
