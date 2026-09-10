import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashMetaCountry, hashMetaEmail, hashMetaExternalId } from '../meta-capi';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('Meta CAPI match-data normalization', () => {
  it('normalizes email before hashing', () => {
    expect(hashMetaEmail(' Buyer@Example.COM ')).toBe(sha256('buyer@example.com'));
  });

  it('hashes a stable first-party external identifier', () => {
    expect(hashMetaExternalId(' visitor-1 ')).toBe(sha256('visitor-1'));
  });

  it('normalizes valid country codes and drops invalid values', () => {
    expect(hashMetaCountry(' LT ')).toBe(sha256('lt'));
    expect(hashMetaCountry('Lithuania')).toBeUndefined();
  });
});
