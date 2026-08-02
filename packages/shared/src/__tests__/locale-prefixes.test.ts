import { describe, expect, it } from 'vitest';
import {
  LOCALE_COMPANY_PREFIXES,
  solidgateOrderDescription,
} from '../locale-prefixes';
import { routing } from '@repo/i18n/routing';
import { SOLIDGATE_PRODUCT_CODES } from '../solidgate/catalog';

describe('order-description grammar', () => {
  it('covers every routing locale with a prefix', () => {
    for (const locale of routing.locales) {
      expect(LOCALE_COMPANY_PREFIXES[locale], locale).toBeTruthy();
    }
  });

  it('main checkout: {PREFIX}_{code}', () => {
    expect(solidgateOrderDescription('en', SOLIDGATE_PRODUCT_CODES.main)).toBe(
      'EN_BRAND_000000_SUB',
    );
    expect(solidgateOrderDescription('zh-TW', SOLIDGATE_PRODUCT_CODES.main)).toBe(
      'TW_BRAND_000000_SUB',
    );
  });

  it('OTO: {PREFIX}_{code} o:{PREFIX}_{origin}', () => {
    expect(
      solidgateOrderDescription(
        'en',
        SOLIDGATE_PRODUCT_CODES.lifetime,
        SOLIDGATE_PRODUCT_CODES.main,
      ),
    ).toBe('EN_BRANDLIFETIME_000000_SUB o:EN_BRAND_000000_SUB');
    expect(
      solidgateOrderDescription(
        'ja',
        SOLIDGATE_PRODUCT_CODES.addon,
        SOLIDGATE_PRODUCT_CODES.main,
      ),
    ).toBe('JP_BRANDADDON_000000_SUB o:JP_BRAND_000000_SUB');
  });

  it('unknown locale degrades to the bare code, never throws', () => {
    expect(solidgateOrderDescription('xx', SOLIDGATE_PRODUCT_CODES.pdf5)).toBe(
      'BRANDPDF5_000000_PDF',
    );
  });
});
