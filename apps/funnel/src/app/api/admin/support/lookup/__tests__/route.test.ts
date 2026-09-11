import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAdmin: vi.fn(),
  lookup: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('@/app/admin/_queries/admin-access', () => ({
  getAuthenticatedAdminUser: mocks.getAdmin,
}));

vi.mock('@/features/admin/adapters/supabase-solidgate', () => ({
  supabaseSolidgateSupportAdapter: {
    id: 'supabase-solidgate',
    lookupExactEmail: mocks.lookup,
  },
}));

vi.mock('@/features/admin/rate-limit', () => ({
  consumeAdminRateLimit: mocks.consumeRateLimit,
}));

import { POST } from '../route';

function request(body: unknown, contentType = 'application/json') {
  return new Request('https://example.test/api/admin/support/lookup', {
    method: 'POST',
    headers: { 'Content-Type': contentType, Origin: 'https://example.test' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/support/lookup', () => {
  beforeEach(() => {
    mocks.getAdmin.mockReset();
    mocks.lookup.mockReset();
    mocks.consumeRateLimit.mockReset();
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  });

  it('rejects a request without an allowlisted admin session', async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const response = await POST(request({ email: 'customer@example.com' }));
    expect(response.status).toBe(401);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it('requires JSON and validates the exact email before querying', async () => {
    mocks.getAdmin.mockResolvedValue({ id: 'admin-id' });
    expect((await POST(request({ email: 'customer@example.com' }, 'text/plain'))).status).toBe(415);
    expect((await POST(request({ email: 'not-an-email' }))).status).toBe(400);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it('returns an uncached sanitized report envelope', async () => {
    mocks.getAdmin.mockResolvedValue({ id: 'admin-id' });
    mocks.lookup.mockResolvedValue({ version: 1, email: 'customer@example.com' });
    const response = await POST(request({ email: ' Customer@Example.com ' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(mocks.lookup).toHaveBeenCalledWith(
      'customer@example.com',
      expect.objectContaining({ version: 1 }),
    );
  });

  it('rejects cross-site requests and fails closed when rate limiting is unavailable', async () => {
    mocks.getAdmin.mockResolvedValue({ id: 'admin-id' });
    const crossSite = new Request('https://example.test/api/admin/support/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.test',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ email: 'customer@example.com' }),
    });
    expect((await POST(crossSite)).status).toBe(400);

    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, unavailable: true });
    expect((await POST(request({ email: 'customer@example.com' }))).status).toBe(503);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});
