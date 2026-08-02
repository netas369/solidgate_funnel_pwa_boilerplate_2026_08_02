import { describe, it, expect, beforeEach } from 'vitest';
import { useAnalyticsStore } from '@/stores/analytics-store';

describe('useAnalyticsStore', () => {
  beforeEach(() => {
    useAnalyticsStore.setState({ events: [] });
  });

  it('has an empty initial events array', () => {
    expect(useAnalyticsStore.getState().events).toEqual([]);
  });

  it('trackEvent adds an event with type, timestamp, and optional metadata', () => {
    useAnalyticsStore.getState().trackEvent('quiz_started', { sessionId: 'x' });
    const events = useAnalyticsStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('quiz_started');
    expect(events[0].metadata).toEqual({ sessionId: 'x' });
    expect(typeof events[0].timestamp).toBe('number');
  });

  it('trackEvent works without metadata', () => {
    useAnalyticsStore.getState().trackEvent('quiz_started');
    const events = useAnalyticsStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('quiz_started');
    expect(events[0].metadata).toBeUndefined();
  });

  it('getEventsByType returns only matching events', () => {
    const { trackEvent } = useAnalyticsStore.getState();
    trackEvent('quiz_started');
    trackEvent('step_completed', { step: 1 });
    trackEvent('step_completed', { step: 2 });
    trackEvent('lead_captured');

    const stepEvents = useAnalyticsStore.getState().getEventsByType('step_completed');
    expect(stepEvents).toHaveLength(2);
    expect(stepEvents.every((e) => e.type === 'step_completed')).toBe(true);
  });

  it('clearEvents empties the events array', () => {
    useAnalyticsStore.getState().trackEvent('quiz_started');
    useAnalyticsStore.getState().trackEvent('step_completed');
    expect(useAnalyticsStore.getState().events).toHaveLength(2);

    useAnalyticsStore.getState().clearEvents();
    expect(useAnalyticsStore.getState().events).toEqual([]);
  });
});
