import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { LiveAutoRefresh } from './LiveAutoRefresh';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

/** jsdom's visibilityState is read-only; override the getter to drive it. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockRefresh.mockClear();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LiveAutoRefresh', () => {
  it('refreshes on the interval while mounted', () => {
    render(<LiveAutoRefresh intervalMs={10_000} />);
    expect(mockRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20_000);
    expect(mockRefresh).toHaveBeenCalledTimes(3);
  });

  it('STOPS once unmounted', () => {
    // The bug this component exists to fix. A <meta http-equiv="refresh"> stayed
    // scheduled in the browser after React removed it, hard-navigating the
    // analyst back to Live ten seconds after they clicked a different tab.
    const { unmount } = render(<LiveAutoRefresh intervalMs={10_000} />);
    vi.advanceTimersByTime(10_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    unmount();

    vi.advanceTimersByTime(60_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden', () => {
    // A wall board left open must not query every 10s for nobody.
    render(<LiveAutoRefresh intervalMs={10_000} />);
    setVisibility('hidden');

    vi.advanceTimersByTime(60_000);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes immediately on return, then resumes polling', () => {
    render(<LiveAutoRefresh intervalMs={10_000} />);
    setVisibility('hidden');
    vi.advanceTimersByTime(60_000);
    expect(mockRefresh).not.toHaveBeenCalled();

    // Coming back to a stale board should not mean waiting another 10s.
    setVisibility('visible');
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not stack timers when visibility flaps', () => {
    // Repeated visible→visible events must not start a second interval, or the
    // board would refresh twice, then three times, per tick.
    render(<LiveAutoRefresh intervalMs={10_000} />);
    setVisibility('visible');
    setVisibility('visible');
    mockRefresh.mockClear();

    vi.advanceTimersByTime(10_000);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
