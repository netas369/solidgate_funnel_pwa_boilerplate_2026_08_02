import { describe, expect, it } from 'vitest';
import { readSameOriginAdminJson } from '../request';

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('https://example.test/api/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.test',
      ...headers,
    },
    body,
  });
}

describe('admin JSON request guard', () => {
  it('accepts a bounded same-origin JSON object', async () => {
    await expect(readSameOriginAdminJson(request('{"ok":true}'), 100)).resolves.toEqual({
      ok: true,
      body: { ok: true },
    });
  });

  it('rejects missing origins, cross-site requests, arrays, and oversized bodies', async () => {
    const missingOrigin = request('{}');
    missingOrigin.headers.delete('origin');
    expect((await readSameOriginAdminJson(missingOrigin, 100)).ok).toBe(false);
    expect((await readSameOriginAdminJson(request('{}', {
      Origin: 'https://attacker.test',
      'Sec-Fetch-Site': 'cross-site',
    }), 100)).ok).toBe(false);
    expect((await readSameOriginAdminJson(request('[]'), 100)).ok).toBe(false);
    const oversized = await readSameOriginAdminJson(request('{"long":"value"}'), 5);
    expect(oversized).toMatchObject({ ok: false, status: 413 });
  });
});
