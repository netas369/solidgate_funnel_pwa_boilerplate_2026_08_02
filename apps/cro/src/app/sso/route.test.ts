import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const verifyOtp = vi.fn();
const signOut = vi.fn();
const isCroAnalyst = vi.fn();

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp, signOut } }),
}));
vi.mock('@/lib/cro-auth', () => ({ isCroAnalyst: (...a: unknown[]) => isCroAnalyst(...a) }));

const { GET } = await import('./route');

const go = (query: string) =>
  GET(new NextRequest(`https://cro.example.com/sso${query}`));

beforeEach(() => {
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  signOut.mockReset().mockResolvedValue({});
  isCroAnalyst.mockReset().mockResolvedValue(true);
});

/**
 * The handoff PMC Hub uses. Everything here is about what happens when it does
 * NOT work: a stale link, a replayed one, an analyst removed between the mint
 * and the click. In all of them the honest next step is the same — sign in
 * normally — so none of them may land on an error page.
 */
describe('/sso', () => {
  it('lets a valid token straight into the dashboard', async () => {
    const res = await go('?token=abc123');
    expect(res.headers.get('location')).toBe('https://cro.example.com/dashboard');
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123', type: 'email' });
  });

  it('never carries the token onward', async () => {
    // A redirect sends no Referer to the destination and the destination URL
    // holds none of it, so the credential does not reach history or logs.
    const res = await go('?token=abc123');
    expect(res.headers.get('location')).not.toContain('abc123');
  });

  it.each([
    ['', 'missing'],
    ['?token=', 'missing'],
  ])('sends %s back to sign in as "%s"', async (query, reason) => {
    const res = await go(query);
    expect(res.headers.get('location')).toBe(`https://cro.example.com/login?sso=${reason}`);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('rejects an absurdly long token without a round trip', async () => {
    const res = await go(`?token=${'x'.repeat(600)}`);
    expect(res.headers.get('location')).toContain('sso=invalid');
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('sends a spent or stale token back to sign in', async () => {
    // Single-use and short-lived, so this is the ordinary case: a link opened
    // twice, or opened tomorrow.
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired' } });
    const res = await go('?token=abc123');
    expect(res.headers.get('location')).toContain('sso=expired');
  });

  it('tears the session down for a valid token belonging to a non-analyst', async () => {
    // Removed from cro_analysts between the mint and the click. A valid token
    // must not leave them holding a session on this domain.
    isCroAnalyst.mockResolvedValue(false);
    const res = await go('?token=abc123');
    expect(signOut).toHaveBeenCalledOnce();
    expect(res.headers.get('location')).toContain('sso=denied');
  });

  it('checks membership on the client that just verified, not a fresh one', async () => {
    // verifyOtp writes the session through cookieStore.set, and a second
    // createClient() in the same request reads cookies() — which does not yet
    // reflect that write. A fresh client would run unauthenticated and lock
    // out every legitimate analyst.
    await go('?token=abc123');
    const [client] = isCroAnalyst.mock.calls[0] as [{ auth: unknown }];
    expect(client.auth).toBeDefined();
    expect((client as { auth: { verifyOtp: unknown } }).auth.verifyOtp).toBe(verifyOtp);
  });

  it('never lands anywhere but /login on failure', async () => {
    for (const setup of [
      () => verifyOtp.mockResolvedValue({ error: { message: 'bad' } }),
      () => isCroAnalyst.mockResolvedValue(false),
    ]) {
      beforeEachReset();
      setup();
      const res = await go('?token=abc123');
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    }
  });
});

function beforeEachReset() {
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  signOut.mockReset().mockResolvedValue({});
  isCroAnalyst.mockReset().mockResolvedValue(true);
}
