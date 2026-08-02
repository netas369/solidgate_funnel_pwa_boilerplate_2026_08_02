import { describe, expect, it } from 'vitest';
import {
  SOLIDGATE_DESCRIPTOR_SUFFIXES,
  solidgateDynamicDescriptor,
} from '../solidgate/descriptor';
import { SOLIDGATE_PRODUCT_CODES } from '../solidgate/catalog';

// SchemaCardsDynamicDescriptor: 1-10 chars, ASCII printable minus `^`.
const SOLIDGATE_SUFFIX_PATTERN = /^[\x20-\x5D\x5F-\x7E]{1,10}$/;

describe('solidgate dynamic descriptor suffixes', () => {
  it('every offering code has a suffix', () => {
    for (const code of Object.values(SOLIDGATE_PRODUCT_CODES)) {
      expect(SOLIDGATE_DESCRIPTOR_SUFFIXES[code], code).toBeTruthy();
    }
  });

  it('every suffix satisfies Solidgate constraints (1-10 ASCII chars, no ^)', () => {
    for (const [code, suffix] of Object.entries(SOLIDGATE_DESCRIPTOR_SUFFIXES)) {
      expect(suffix, `${code} -> "${suffix}"`).toMatch(SOLIDGATE_SUFFIX_PATTERN);
    }
  });

  it('main plan carries the brand (rebills may show only the base + this)', () => {
    expect(solidgateDynamicDescriptor(SOLIDGATE_PRODUCT_CODES.main)).toEqual({
      suffix: 'ACME',
    });
  });

  it('unknown code returns undefined so the field is omitted, never invalid', () => {
    expect(solidgateDynamicDescriptor('NOT_A_CODE')).toBeUndefined();
  });
});
