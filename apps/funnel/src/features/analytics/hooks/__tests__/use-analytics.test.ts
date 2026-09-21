import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock dependencies
vi.mock('../../lib/posthog', () => ({
  capturePostHogEvent: vi.fn(),
}));

vi.mock('../../lib/gtm', () => ({
  pushDataLayerEvent: vi.fn(),
}));

vi.mock('../../lib/meta-pixel', () => ({
  trackMetaEvent: vi.fn(() => true),
  trackMetaCustomEvent: vi.fn(() => true),
}));

vi.mock('../../lib/meta-event-id', () => ({
  generateMetaEventId: vi.fn(() => 'random-fallback'),
}));

vi.mock('../../lib/meta-capi-client', () => ({
  sendCapiFromBrowser: vi.fn(),
}));

vi.mock('@/features/quiz/lib/track-funnel-event', () => ({
  trackFunnelEvent: vi.fn(),
}));

import { useAnalytics } from '../use-analytics';
import { trackFunnelEvent } from '@/features/quiz/lib/track-funnel-event';
import { capturePostHogEvent } from '../../lib/posthog';
import { pushDataLayerEvent } from '../../lib/gtm';
import { trackMetaCustomEvent, trackMetaEvent } from '../../lib/meta-pixel';
import { sendCapiFromBrowser } from '../../lib/meta-capi-client';
import { useAnalyticsStore } from '@/stores/analytics-store';

describe('useAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnalyticsStore.getState().clearEvents();
  });

  it('track() dispatches to all three destinations', () => {
    const { result } = renderHook(() => useAnalytics());

    act(() => {
      result.current.track('step_completed', { step_id: '003' });
    });

    // 1. Analytics store
    const events = useAnalyticsStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('step_completed');
    expect(events[0].metadata).toEqual({ step_id: '003' });

    // 2. PostHog
    expect(capturePostHogEvent).toHaveBeenCalledWith('step_completed', {
      step_id: '003',
    });

    // 3. GTM dataLayer
    expect(pushDataLayerEvent).toHaveBeenCalledWith('step_completed', {
      step_id: '003',
    });
  });

  it('track() works without metadata', () => {
    const { result } = renderHook(() => useAnalytics());

    act(() => {
      result.current.track('quiz_started');
    });

    const events = useAnalyticsStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('quiz_started');
    expect(capturePostHogEvent).toHaveBeenCalledWith('quiz_started', undefined);
    expect(pushDataLayerEvent).toHaveBeenCalledWith('quiz_started', undefined);
  });

  describe('funnel_events DB mirror', () => {
    it('mirrors checkout_completed to the DB with the sanitized metadata', () => {
      const { result } = renderHook(() => useAnalytics());
      act(() => {
        result.current.track('checkout_completed', {
          session_id: 'session-123',
          value: 9,
          currency: 'EUR',
          capi_email: 'buyer@example.com',
        });
      });
      expect(trackFunnelEvent).toHaveBeenCalledWith(
        'session-123',
        'checkout_completed',
        undefined,
        expect.not.objectContaining({ capi_email: expect.anything() }),
      );
    });

    it('collapses per-OTO event names onto the generic DB types, keeping the original name', () => {
      const { result } = renderHook(() => useAnalytics());
      act(() => {
        result.current.track('oto1_viewed', { session_id: 's1', product: 'oto1_lifetime' });
        result.current.track('oto3_declined', { session_id: 's1', product: 'oto3_bundle' });
        result.current.track('oto2_purchased', { session_id: 's1', product: 'oto2_addon_weekly' });
      });
      expect(trackFunnelEvent).toHaveBeenCalledWith(
        's1',
        'oto_viewed',
        undefined,
        expect.objectContaining({ source_event: 'oto1_viewed' }),
      );
      expect(trackFunnelEvent).toHaveBeenCalledWith(
        's1',
        'oto_declined',
        undefined,
        expect.objectContaining({ source_event: 'oto3_declined' }),
      );
      expect(trackFunnelEvent).toHaveBeenCalledWith(
        's1',
        'oto_accepted',
        undefined,
        expect.objectContaining({ source_event: 'oto2_purchased' }),
      );
    });

    it('skips the DB mirror when session_id is missing (NOT NULL FK)', () => {
      const { result } = renderHook(() => useAnalytics());
      act(() => {
        result.current.track('oto_viewed', { product: 'main' });
      });
      expect(trackFunnelEvent).not.toHaveBeenCalled();
    });

    it('does not mirror quiz events the quiz already writes directly', () => {
      const { result } = renderHook(() => useAnalytics());
      act(() => {
        result.current.track('step_completed', { session_id: 's1', step_id: '003' });
        result.current.track('lead_captured', { session_id: 's1' });
        result.current.track('checkout_opened', { session_id: 's1' });
      });
      expect(trackFunnelEvent).not.toHaveBeenCalled();
    });
  });

  it('uses the canonical purchase event ID for Pixel/CAPI dedupe and forwards session binding', () => {
    const { result } = renderHook(() => useAnalytics());
    act(() => {
      result.current.track('checkout_completed', {
        event_id: 'purchase:order-123',
        transaction_id: 'order-123',
        session_id: 'session-123',
        product_id: 'solidgate-product-id',
        value: 13,
        currency: 'EUR',
        capi_email: 'buyer@example.com',
      });
    });

    expect(trackMetaEvent).toHaveBeenCalledWith(
      'Purchase',
      expect.objectContaining({
        value: 13,
        currency: 'EUR',
        content_ids: ['solidgate-product-id'],
      }),
      { eventID: 'purchase:order-123' },
    );
    expect(sendCapiFromBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'Purchase',
        eventId: 'purchase:order-123',
        sessionId: 'session-123',
        customData: expect.objectContaining({
          value: 13,
          currency: 'EUR',
          content_ids: ['solidgate-product-id'],
        }),
      }),
    );
    // Delivery telemetry: every Purchase reports whether fbq actually fired.
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'meta_pixel_delivery',
      expect.objectContaining({
        meta_event: 'Purchase',
        event_id: 'purchase:order-123',
        pixel_fired: expect.any(Boolean),
      }),
    );
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'checkout_completed',
      expect.not.objectContaining({ capi_email: expect.anything() }),
    );
  });

  it('reports a server-confirmed €0 trial as StartTrial, never a $0 Purchase', () => {
    const { result } = renderHook(() => useAnalytics());
    act(() => {
      result.current.track('checkout_completed', {
        event_id: 'purchase:order-free-1',
        session_id: 'session-123',
        product_id: 'solidgate-product-id',
        value: 0,
        currency: 'EUR',
        authorized_trial: true,
      });
    });

    expect(trackMetaEvent).toHaveBeenCalledWith(
      'StartTrial',
      expect.objectContaining({
        value: 0,
        currency: 'EUR',
        content_ids: ['solidgate-product-id'],
      }),
      { eventID: 'purchase:order-free-1' },
    );
    expect(sendCapiFromBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'StartTrial',
        eventId: 'purchase:order-free-1',
        sessionId: 'session-123',
      }),
    );
  });

  it('emits a genuine OTO checkout_completed to Pixel and CAPI as Purchase', () => {
    const { result } = renderHook(() => useAnalytics());
    act(() => {
      result.current.track('checkout_completed', {
        event_id: 'purchase:oto-order-1',
        session_id: 'session-123',
        product_id: 'solidgate-product-id',
        product_category: 'oto',
        value: 59,
        currency: 'EUR',
      });
    });

    expect(trackMetaEvent).toHaveBeenCalledWith(
      'Purchase',
      expect.objectContaining({
        value: 59,
        currency: 'EUR',
        content_ids: ['solidgate-product-id'],
      }),
      { eventID: 'purchase:oto-order-1' },
    );
    expect(sendCapiFromBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'Purchase',
        eventId: 'purchase:oto-order-1',
        sessionId: 'session-123',
      }),
    );
    // Internal analytics keep receiving the OTO purchase unchanged.
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'checkout_completed',
      expect.objectContaining({ product_category: 'oto' }),
    );
  });

  it('still skips a zero-value checkout_completed without the authorized_trial flag', () => {
    const { result } = renderHook(() => useAnalytics());
    act(() => {
      result.current.track('checkout_completed', {
        session_id: 'session-123',
        value: 0,
        currency: 'USD',
      });
    });

    expect(trackMetaEvent).not.toHaveBeenCalled();
    expect(sendCapiFromBrowser).not.toHaveBeenCalled();
    // The guard skip is no longer silent: telemetry reports the reason.
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'meta_pixel_delivery',
      expect.objectContaining({
        pixel_fired: false,
        skip_reason: 'missing_value_or_currency',
      }),
    );
  });

  it('reports a guard skip when a main Purchase arrives without currency', () => {
    const { result } = renderHook(() => useAnalytics());
    act(() => {
      result.current.track('checkout_completed', {
        event_id: 'purchase:order-nocur',
        session_id: 'session-123',
        product_category: 'main',
        value: 17.67,
      });
    });

    expect(trackMetaEvent).not.toHaveBeenCalled();
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      'meta_pixel_delivery',
      expect.objectContaining({
        pixel_fired: false,
        skip_reason: 'missing_value_or_currency',
        event_id: 'purchase:order-nocur',
        product_category: 'main',
      }),
    );
  });

  it('sends quiz milestones without answers, result segments, or raw session identifiers', () => {
    const { result } = renderHook(() => useAnalytics());
    act(() => {
      result.current.track('step_completed', {
        session_id: 'session-123',
        step_id: 'sensitive-health-question',
        step_number: 4,
        answers: { health: 'private' },
        result_segment: 'private-profile',
      });
    });

    expect(trackMetaCustomEvent).toHaveBeenCalledWith(
      'QuizStepCompleted',
      expect.objectContaining({ step_number: 4 }),
      { eventID: 'random-fallback' },
    );
    const pixelProperties = vi.mocked(trackMetaCustomEvent).mock.calls[0]?.[1];
    expect(pixelProperties).not.toHaveProperty('answers');
    expect(pixelProperties).not.toHaveProperty('result_segment');
    expect(pixelProperties).not.toHaveProperty('step_id');
    expect(pixelProperties).not.toHaveProperty('session_id');
    expect(sendCapiFromBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'QuizStepCompleted',
        sessionId: 'session-123',
        customData: expect.objectContaining({
          step_number: 4,
          content_category: 'quiz',
        }),
      }),
    );
  });

  it('track() dispatches to the analytics store and both trackers', () => {
    const { result } = renderHook(() => useAnalytics());

    act(() => {
      result.current.track('oto_viewed', { oto: 1 });
    });

    const events = useAnalyticsStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('oto_viewed');

    expect(capturePostHogEvent).toHaveBeenCalledWith('oto_viewed', { oto: 1 });
    expect(pushDataLayerEvent).toHaveBeenCalledWith('oto_viewed', { oto: 1 });
  });
});
