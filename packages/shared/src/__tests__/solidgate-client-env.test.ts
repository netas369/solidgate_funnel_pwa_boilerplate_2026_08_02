import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSolidgateKeys } from '../solidgate/client';

const MANAGED_KEYS = [
  'VERCEL_ENV',
  'SOLIDGATE_ENVIRONMENT',
  'SOLIDGATE_API_PUBLIC_KEY',
  'SOLIDGATE_API_SECRET_KEY',
] as const;

const originalEnvironment = Object.fromEntries(
  MANAGED_KEYS.map((key) => [key, process.env[key]]),
);

describe('getSolidgateKeys deployment binding', () => {
  beforeEach(() => {
    process.env.SOLIDGATE_API_PUBLIC_KEY = 'api-public';
    process.env.SOLIDGATE_API_SECRET_KEY = 'api-secret';
    delete process.env.VERCEL_ENV;
    delete process.env.SOLIDGATE_ENVIRONMENT;
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts live keys only when Production carries the production marker', () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SOLIDGATE_ENVIRONMENT = 'production';

    expect(getSolidgateKeys()).toEqual({
      publicKey: 'api-public',
      secretKey: 'api-secret',
    });
  });

  it('rejects a missing or sandbox marker in Production', () => {
    process.env.VERCEL_ENV = 'production';
    expect(() => getSolidgateKeys()).toThrow(
      'SOLIDGATE_ENVIRONMENT must be "production"',
    );

    process.env.SOLIDGATE_ENVIRONMENT = 'sandbox';
    expect(() => getSolidgateKeys()).toThrow(
      'SOLIDGATE_ENVIRONMENT must be "production"',
    );
  });

  it('accepts sandbox keys only when Preview carries the sandbox marker', () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.SOLIDGATE_ENVIRONMENT = 'sandbox';

    expect(getSolidgateKeys()).toEqual({
      publicKey: 'api-public',
      secretKey: 'api-secret',
    });
  });

  it('rejects a missing or production marker in Preview', () => {
    process.env.VERCEL_ENV = 'preview';
    expect(() => getSolidgateKeys()).toThrow(
      'SOLIDGATE_ENVIRONMENT must be "sandbox"',
    );

    process.env.SOLIDGATE_ENVIRONMENT = 'production';
    expect(() => getSolidgateKeys()).toThrow(
      'SOLIDGATE_ENVIRONMENT must be "sandbox"',
    );
  });

  it('does not require a marker for local or Vercel development', () => {
    expect(getSolidgateKeys()).toEqual({
      publicKey: 'api-public',
      secretKey: 'api-secret',
    });

    process.env.VERCEL_ENV = 'development';
    expect(getSolidgateKeys()).toEqual({
      publicKey: 'api-public',
      secretKey: 'api-secret',
    });
  });
});
