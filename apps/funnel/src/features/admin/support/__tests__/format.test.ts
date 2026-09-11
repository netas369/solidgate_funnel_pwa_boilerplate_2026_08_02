import { describe, expect, it } from 'vitest';
import {
  formatSupportAmount,
  humanizeSupportValue,
  normalizeSupportEmail,
  statusTone,
} from '../format';

describe('admin support formatting', () => {
  it('normalizes one exact customer email', () => {
    expect(normalizeSupportEmail('  Customer@Example.COM ')).toEqual({
      ok: true,
      email: 'customer@example.com',
    });
  });

  it.each([
    null,
    '',
    'not-an-email',
    'first@example.com second@example.com',
    `${'a'.repeat(310)}@example.com`,
  ])('rejects invalid lookup input: %p', (value) => {
    expect(normalizeSupportEmail(value).ok).toBe(false);
  });

  it('uses readable neutral labels without product vocabulary', () => {
    expect(humanizeSupportValue('checkout_only')).toBe('Checkout Only');
    expect(humanizeSupportValue('send-login-code')).toBe('Send Login Code');
  });

  it('formats minor currency amounts', () => {
    expect(formatSupportAmount(1299, 'eur')).toMatch(/12[.,]99/);
  });

  it('maps operational states to consistent tones', () => {
    expect(statusTone('completed')).toBe('positive');
    expect(statusTone('manual_review')).toBe('critical');
    expect(statusTone('pending')).toBe('warning');
    expect(statusTone('unknown')).toBe('neutral');
  });
});
