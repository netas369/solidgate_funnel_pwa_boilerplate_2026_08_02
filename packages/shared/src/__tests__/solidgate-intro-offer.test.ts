import { describe, expect, it } from 'vitest';
import { introOfferEmailHash } from '../solidgate/intro-offer';

describe('introOfferEmailHash', () => {
  it('normalizes case and surrounding whitespace deterministically', async () => {
    await expect(introOfferEmailHash('  Buyer@Example.COM ')).resolves.toBe(
      await introOfferEmailHash('buyer@example.com'),
    );
  });

  it('returns a lowercase SHA-256 hex digest without exposing the email', async () => {
    const hash = await introOfferEmailHash('buyer@example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('buyer');
  });
});
