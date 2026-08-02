import { describe, it, expect } from 'vitest';
import { hashEmail } from '../hash-email';

describe('hashEmail', () => {
  it('produces SHA-256 hex of normalized lowercase email', async () => {
    // SHA-256 of 'test@example.com'
    const result = await hashEmail('Test@Example.com');
    expect(result).toBe(
      '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b'
    );
  });

  it('trims whitespace before hashing', async () => {
    const a = await hashEmail('  hello@world.com  ');
    const b = await hashEmail('hello@world.com');
    expect(a).toBe(b);
  });

  it('returns a 64-character hex string', async () => {
    const result = await hashEmail('any@email.com');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
