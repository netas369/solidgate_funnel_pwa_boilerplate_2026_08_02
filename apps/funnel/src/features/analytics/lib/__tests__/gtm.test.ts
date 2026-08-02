import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @next/third-parties/google before importing gtm
vi.mock('@next/third-parties/google', () => ({
  sendGTMEvent: vi.fn(),
  GoogleTagManager: vi.fn(),
}));

import { pushDataLayerEvent } from '../gtm';
import { sendGTMEvent } from '@next/third-parties/google';

describe('pushDataLayerEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendGTMEvent with event name and metadata', () => {
    pushDataLayerEvent('quiz_started', { session_id: '123' });
    expect(sendGTMEvent).toHaveBeenCalledWith({
      event: 'quiz_started',
      session_id: '123',
    });
  });

  it('calls sendGTMEvent with only event when no metadata', () => {
    pushDataLayerEvent('oto_viewed');
    expect(sendGTMEvent).toHaveBeenCalledWith({ event: 'oto_viewed' });
  });

  it('returns early without error when window is undefined (SSR)', () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error -- simulating SSR
    delete globalThis.window;

    expect(() => pushDataLayerEvent('test_event')).not.toThrow();
    expect(sendGTMEvent).not.toHaveBeenCalled();

    globalThis.window = originalWindow;
  });
});
