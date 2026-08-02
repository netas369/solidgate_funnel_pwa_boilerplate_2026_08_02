import { describe, expect, it } from 'vitest';
import {
  currentPaymentEnvironment,
  paymentEnvironmentForVercel,
} from '../payment-environment';

describe('payment environment isolation', () => {
  it('uses production only for an explicit Vercel production deployment', () => {
    expect(paymentEnvironmentForVercel('production')).toBe('production');
  });

  it.each([undefined, 'preview', 'development', 'test', '']) (
    'treats %s as sandbox',
    (vercelEnvironment) => {
      expect(paymentEnvironmentForVercel(vercelEnvironment)).toBe('sandbox');
    },
  );

  it('derives the current environment from VERCEL_ENV', () => {
    const previous = process.env.VERCEL_ENV;

    try {
      process.env.VERCEL_ENV = 'production';
      expect(currentPaymentEnvironment()).toBe('production');

      process.env.VERCEL_ENV = 'preview';
      expect(currentPaymentEnvironment()).toBe('sandbox');
    } finally {
      if (previous === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = previous;
      }
    }
  });
});
