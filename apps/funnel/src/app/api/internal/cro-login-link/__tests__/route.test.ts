import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const maybeSingle = vi.fn();
const generateLink = vi.fn();
/** The value the analyst lookup actually filtered on. */
const lookedUp = vi.fn<(column: string, value: string) => void>();

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (column: string, value: string) => {
          lookedUp(column, value);
          return { maybeSingle };
        },
      }),
    }),
    auth: { admin: { generateLink } },
  }),
}));

const { POST } = await import('../route');

const SECRET = 'a-test-internal-secret';

function post(body: unknown, secret?: string) {
  return POST(
    new Request('https://funnel.example.com/api/internal/cro-login-link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret === undefined ? {} : { 'x-internal-secret': secret }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.NEXT_PUBLIC_CRO_URL = 'https://cro.example.com';
  lookedUp.mockReset();
  maybeSingle.mockReset().mockResolvedValue({ data: { email: 'a@b.test' }, error: null });
  generateLink
    .mockReset()
    .mockResolvedValue({ data: { properties: { hashed_token: 'HASH' } }, error: null });
});
afterEach(() => {
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.NEXT_PUBLIC_CRO_URL;
});

/**
 * The one endpoint that can open a CRO board for someone who did not sign in.
 *
 * The property worth protecting: holding INTERNAL_API_SECRET lets PMC Hub open
 * the board as SOMEONE ALREADY ON THE ANALYST LIST, and nothing more. It must
 * never be able to grant access — that stays an INSERT a person performs.
 */
describe('POST /api/internal/cro-login-link', () => {
  it('mints a link for an analyst', async () => {
    const res = await post({ email: 'a@b.test' }, SECRET);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      url: 'https://cro.example.com/sso?token=HASH',
    });
  });

  it('REFUSES an address that is not on the list', async () => {
    // The gate. Checked before a link exists, so the secret cannot mint entry
    // for someone nobody granted.
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await post({ email: 'stranger@b.test' }, SECRET);
    expect(res.status).toBe(403);
    expect(generateLink).not.toHaveBeenCalled();
  });

  it.each([
    ['no secret', undefined],
    ['the wrong secret', 'wrong'],
    ['an empty secret', ''],
  ])('rejects %s', async (_label, secret) => {
    const res = await post({ email: 'a@b.test' }, secret);
    expect(res.status).toBe(401);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('rejects a secret that merely shares a prefix', async () => {
    const res = await post({ email: 'a@b.test' }, SECRET.slice(0, 5));
    expect(res.status).toBe(401);
  });

  it('fails closed when the secret is not configured at all', async () => {
    // Otherwise an unset variable would compare equal to a missing header and
    // the endpoint would be open.
    delete process.env.INTERNAL_API_SECRET;
    expect((await post({ email: 'a@b.test' }, SECRET)).status).toBe(401);
    expect((await post({ email: 'a@b.test' }, undefined)).status).toBe(401);
  });

  it('lowercases and trims, because cro_analysts stores and CHECKs lowercase', async () => {
    // Otherwise a capitalised address never matches, and the refusal reads as
    // "not an analyst" rather than as a typo.
    await post({ email: '  Analyst@Example.TEST ' }, SECRET);
    expect(lookedUp).toHaveBeenCalledWith('email', 'analyst@example.test');
    expect(generateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: 'analyst@example.test',
    });
  });

  it.each([
    ['a missing email', {}],
    ['a non-string email', { email: 42 }],
    ['something that is not an address', { email: 'nope' }],
  ])('rejects %s', async (_label, body) => {
    expect((await post(body, SECRET)).status).toBe(400);
  });

  it('rejects a malformed body without throwing', async () => {
    expect((await post('{not json', SECRET)).status).toBe(400);
  });

  it('will not build a link when the board URL is unset', async () => {
    // Better a 500 than a link to `undefined/sso`.
    delete process.env.NEXT_PUBLIC_CRO_URL;
    expect((await post({ email: 'a@b.test' }, SECRET)).status).toBe(500);
  });

  it('tolerates a trailing slash on the board URL', async () => {
    process.env.NEXT_PUBLIC_CRO_URL = 'https://cro.example.com/';
    const res = await post({ email: 'a@b.test' }, SECRET);
    await expect(res.json()).resolves.toEqual({
      url: 'https://cro.example.com/sso?token=HASH',
    });
  });

  it('reports a minting failure instead of returning a broken link', async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await post({ email: 'a@b.test' }, SECRET)).status).toBe(500);
  });

  it('does not leak whether the lookup failed or the address is unknown', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const body = (await (await post({ email: 'x@y.test' }, SECRET)).json()) as {
      error: string;
    };
    expect(body.error).toBe('Not an analyst');
  });
});
