import { describe, it, expect } from 'vitest';
import { PRICE_BATCH, PRODUCT_CODE_PREFIX } from '@repo/shared/price-map';
import {
  AC_CAMPAIGN_CODE,
  getAcLocalePrefix,
  getEmailListName,
  getSubscriberListName,
  getBuyerTagName,
  getCustomerTagName,
  AC_MAIN_PLAN_SLUGS,
} from '../constants';

describe('getAcLocalePrefix', () => {
  const cases: Array<[string, string]> = [
    ['en', 'EN'],
    ['lt', 'LT'],
    ['lv', 'LV'],
    ['el', 'GR'],
    ['hr', 'HR'],
    ['cs', 'CZ'],
    ['ru', 'RU'],
    ['zh-TW', 'TW'],
  ];

  it.each(cases)('maps %s -> %s', (locale, expected) => {
    expect(getAcLocalePrefix(locale)).toBe(expected);
  });

  it('falls back to the default prefix for an unknown locale instead of throwing', () => {
    // A throw here used to surface inside the fulfillment outbox as a job that
    // retried forever. A CRM label must never fail a purchase.
    expect(getAcLocalePrefix('xx')).toBe('EN');
  });
});

describe('AC list/tag name templates', () => {
  it('derives the campaign code from the product-code grammar', () => {
    expect(AC_CAMPAIGN_CODE).toBe(`${PRODUCT_CODE_PREFIX}_${PRICE_BATCH}`);
  });

  it('getEmailListName produces correct name', () => {
    expect(getEmailListName('EN')).toBe(`EN_${AC_CAMPAIGN_CODE}_SUB_EMAIL`);
    expect(getEmailListName('GR')).toBe(`GR_${AC_CAMPAIGN_CODE}_SUB_EMAIL`);
    expect(getEmailListName('TW')).toBe(`TW_${AC_CAMPAIGN_CODE}_SUB_EMAIL`);
  });

  it('getSubscriberListName produces correct name', () => {
    expect(getSubscriberListName('CZ')).toBe(`CZ_${AC_CAMPAIGN_CODE}_SUB`);
  });

  it('getBuyerTagName produces correct name with # prefix', () => {
    expect(getBuyerTagName('EN')).toBe(`#EN_${AC_CAMPAIGN_CODE}_SUB`);
    expect(getBuyerTagName('LT')).toBe(`#LT_${AC_CAMPAIGN_CODE}_SUB`);
  });

  it('getCustomerTagName produces correct name', () => {
    expect(getCustomerTagName('EN')).toBe('#EN customers');
    expect(getCustomerTagName('RU')).toBe('#RU customers');
    expect(getCustomerTagName('LT')).toBe('#LT customers');
    expect(getCustomerTagName('CZ')).toBe('#CZ customers');
    expect(getCustomerTagName('TW')).toBe('#TW customers');
  });
});

describe('AC_MAIN_PLAN_SLUGS', () => {
  it('contains the configured trial slugs plus special-offer flows', () => {
    expect(AC_MAIN_PLAN_SLUGS).toEqual([
      'trial1',
      'trial2',
      'trial3',
      'trial4',
      'special_1eur',
      'special_free',
    ]);
  });
});
