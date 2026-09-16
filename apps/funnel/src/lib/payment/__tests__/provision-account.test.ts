import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(), generateLink: vi.fn(), verifyOtp: vi.fn(), getUser: vi.fn(), rpc: vi.fn(), from: vi.fn(),
  mutations: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
}));
vi.mock('@repo/shared/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser, verifyOtp: mocks.verifyOtp } }) }));
vi.mock('@repo/shared/supabase/admin', () => ({ getSupabaseAdminClient: () => ({}) }));
vi.mock('@repo/shared/entitlements', () => ({ upsertEntitlement: vi.fn() }));
import { linkAuthUser } from '../provision-account';

const email = 'victim@example.com';
function admin() {
  return { from: mocks.from, rpc: mocks.rpc, auth: { admin: { createUser: mocks.createUser, generateLink: mocks.generateLink } } } as unknown as Parameters<typeof linkAuthUser>[0]['supabaseAdmin'];
}
async function link(userId: string | null = null) {
  return linkAuthUser({ email, sessionId: 'checkout-session', userId, orderMatch: { column: 'solidgate_order_id', value: 'order' }, supabaseAdmin: admin(), logPrefix: '[test]' });
}

describe('purchase ownership never proves mailbox ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutations.length = 0;
    mocks.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', status: 422 } });
    mocks.rpc.mockResolvedValue({ data: 'victim-id', error: null });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.from.mockImplementation((table: string) => {
      let mutation: typeof mocks.mutations[number] | null = null;
      const chain = { update: vi.fn(), eq: vi.fn(), is: vi.fn(), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
      chain.update.mockImplementation((patch: Record<string, unknown>) => {
        mutation = { table, patch, filters: [] }; mocks.mutations.push(mutation); return chain;
      });
      chain.eq.mockImplementation((column: string, value: unknown) => { mutation?.filters.push([column, value]); return chain; });
      chain.is.mockImplementation((column: string, value: unknown) => { mutation?.filters.push([column, value]); return chain; });
      return chain;
    });
  });
  it('resolves an existing purchase owner without redeeming a generated magic link', async () => {
    expect(await link()).toEqual({ linked: false, userId: 'victim-id', isNewUser: false });
    expect(mocks.rpc).toHaveBeenCalledWith('find_auth_user_id_by_email', { p_email: email });
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.mutations.some(({ patch }) => 'auth_verified_at' in patch)).toBe(false);
  });
  it('does not auto-confirm a new checkout email', async () => {
    mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-id' } }, error: null });
    expect(await link()).toEqual({ linked: false, userId: 'new-id', isNewUser: true });
    expect(mocks.createUser).toHaveBeenCalledWith({ email, email_confirm: false });
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.mutations.some(({ patch }) => 'auth_verified_at' in patch)).toBe(false);
  });
  it.each([
    { id: 'attacker-id', email, email_confirmed_at: '2026-09-01' },
    { id: 'victim-id', email, email_confirmed_at: null },
    { id: 'victim-id', email: 'other@example.com', email_confirmed_at: '2026-09-01' },
  ])('rejects an unproven or mismatched current identity: %o', async (user) => {
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    expect((await link('victim-id')).linked).toBe(false);
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.mutations.some(({ patch }) => 'auth_verified_at' in patch)).toBe(false);
  });
  it('preserves an already verified matching login', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'victim-id', email, email_confirmed_at: '2026-09-01' } }, error: null });
    expect((await link('victim-id')).linked).toBe(true);
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.mutations).toContainEqual({
      table: 'orders', patch: { claimed_at: expect.any(String), auth_verified_at: expect.any(String) },
      filters: expect.arrayContaining([
        ['user_id', 'victim-id'], ['session_id', 'checkout-session'],
        ['solidgate_customer_email', email], ['auth_verified_at', null],
      ]),
    });
  });
  it('preserves purchase ownership if browser-session verification is unavailable', async () => {
    mocks.getUser.mockRejectedValue(new Error('auth unavailable'));
    expect(await link()).toEqual({ linked: false, userId: 'victim-id', isNewUser: false });
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

});
