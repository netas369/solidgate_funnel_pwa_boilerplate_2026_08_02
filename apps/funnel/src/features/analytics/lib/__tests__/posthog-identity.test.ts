import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock('posthog-js', () => ({
  default: {
    reset: mocks.reset,
  },
}));

import { resetPostHogIdentity } from '../posthog';

describe('funnel PostHog identity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resets the identified session before a shared browser starts a new funnel', () => {
    resetPostHogIdentity();
    expect(mocks.reset).toHaveBeenCalledOnce();
  });
});
