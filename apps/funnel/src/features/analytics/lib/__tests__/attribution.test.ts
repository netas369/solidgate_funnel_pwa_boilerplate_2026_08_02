import { beforeEach, describe, expect, it } from 'vitest';
import {
  attributionEventProperties,
  captureAttributionParams,
  readStoredAttribution,
  sanitizeAttributionSnapshot,
  selectFirstTouchUtm,
} from '../attribution';

describe('funnel attribution', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    document.cookie = '_fbc=; path=/; max-age=0';
    document.cookie = '_fbp=; path=/; max-age=0';
  });

  it('keeps first touch, ignores internal navigation and updates a new campaign last touch', () => {
    window.history.replaceState(
      {},
      '',
      '/landing?utm_source=fb&utm_medium=paid_social&utm_campaign=launch&fbclid=fb-first',
    );
    const first = captureAttributionParams();
    expect(first?.first_touch.utm_source).toBe('fb');
    expect(first?.last_touch.fbclid).toBe('fb-first');

    window.history.replaceState({}, '', '/quiz/step-2');
    const internal = captureAttributionParams();
    expect(internal?.last_touch.utm_source).toBe('fb');

    window.history.replaceState(
      {},
      '',
      '/offer?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=g-last',
    );
    const last = captureAttributionParams();
    expect(last?.first_touch.utm_source).toBe('fb');
    expect(last?.last_touch.utm_source).toBe('google');
    expect(last?.last_touch.gclid).toBe('g-last');
    expect(selectFirstTouchUtm(last)).toMatchObject({
      utm_source: 'fb',
      utm_medium: 'paid_social',
      utm_campaign: 'launch',
    });

    expect(attributionEventProperties(last)).toMatchObject({
      utm_source: 'fb',
      first_touch_utm_source: 'fb',
      last_touch_utm_source: 'google',
      fbclid: 'fb-first',
      gclid: 'g-last',
    });
  });

  it('adds Meta attribution cookies when they become available', () => {
    window.history.replaceState({}, '', '/?fbclid=click-1');
    captureAttributionParams();
    document.cookie = '_fbc=fb.1.123.click-1; path=/';
    document.cookie = '_fbp=fb.1.123.browser-1; path=/';
    const stored = readStoredAttribution();
    expect(stored?.fbc).toBe('fb.1.123.click-1');
    expect(stored?.fbp).toBe('fb.1.123.browser-1');
  });

  it('sanitizes untrusted payloads and enforces Solidgate field length', () => {
    const snapshot = sanitizeAttributionSnapshot({
      first_touch: { utm_campaign: `  ${'x'.repeat(500)}  `, unknown: 'drop-me' },
      last_touch: { ttclid: ' tt-1 ' },
      fbc: 123,
    });
    expect(snapshot?.first_touch.utm_campaign).toHaveLength(380);
    expect(snapshot?.last_touch.ttclid).toBe('tt-1');
    expect(snapshot?.fbc).toBeUndefined();
    expect(snapshot?.first_touch).not.toHaveProperty('unknown');
  });
});
