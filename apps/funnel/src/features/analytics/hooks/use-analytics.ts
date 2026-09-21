'use client';

import { useCallback } from 'react';
import type { Json } from '@repo/shared/types/database';
import { useAnalyticsStore } from '@/stores/analytics-store';
import { trackFunnelEvent } from '@/features/quiz/lib/track-funnel-event';
import { capturePostHogEvent } from '../lib/posthog';
import { pushDataLayerEvent } from '../lib/gtm';
import { trackMetaCustomEvent, trackMetaEvent } from '../lib/meta-pixel';
import { generateMetaEventId } from '../lib/meta-event-id';
import { sendCapiFromBrowser } from '../lib/meta-capi-client';
import { attributionEventProperties } from '../lib/attribution';
import { purchaseEventValue } from '../lib/purchase-value';

/**
 * Internal funnel event → Meta event.
 *
 * Only mapped events reach Meta; everything else stays in PostHog / GTM / the
 * funnel_events mirror. checkout_completed → Purchase fires only when
 * value + currency are present. A verified zero-cost subscription becomes
 * StartTrial instead.
 *
 * TODO(new product): the LEFT column is this funnel's own vocabulary — rename
 * it with your steps. Keep standard Meta names standard; quiz-only events are
 * explicitly sent as custom events.
 */
const META_EVENT_MAP: Record<string, { name: string; custom?: boolean }> = {
  quiz_started: { name: 'ViewContent' },
  step_completed: { name: 'QuizStepCompleted', custom: true },
  quiz_completed: { name: 'QuizCompleted', custom: true },
  lead_captured: { name: 'Lead' },
  tier_selected: { name: 'AddToCart' },
  checkout_opened: { name: 'InitiateCheckout' },
  checkout_completed: { name: 'Purchase' },
};

/**
 * When true, a €0 checkout_completed that the SERVER confirmed opened a real
 * subscription (`authorized_trial`) reports StartTrial instead of Purchase, so
 * a free-intro tier is still a conversion signal rather than a silent gap.
 */
const REPORT_ZERO_VALUE_TRIALS_AS_START_TRIAL = true;

const META_PRIVATE_PROPERTY_KEYS = new Set([
  'answers',
  'quiz_answers',
  'quiz_result',
  'result',
  'result_segment',
  'email',
  'capi_email',
  'full_name',
  'name',
  'fbc',
  'fbp',
  'session_id',
  'user_id',
  'visitor_id',
  'event_id',
  'eventId',
]);

function metaSafeProperties(
  event: string,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...attributionEventProperties(),
    ...(metadata ?? {}),
  };
  for (const key of META_PRIVATE_PROPERTY_KEYS) delete properties[key];
  // Stable step numbers are enough for optimization. A product's step key can
  // disclose the meaning of a sensitive health/profile question.
  if (event === 'step_completed') delete properties.step_id;
  return properties;
}

type TrackMetadata = Record<string, unknown> & {
  /** Legacy call-site field. Always stripped; CAPI reads email from the verified session. */
  capi_email?: string;
};

/**
 * Post-quiz events mirrored into the funnel_events DB table, keyed by the
 * only event types its CHECK constraint accepts. Per-OTO names
 * (oto1_viewed, ...) collapse onto the generic types; otoN_purchased maps to
 * oto_accepted, matching the main offer's accepted→completed pair. Quiz
 * events (quiz_started, step_completed, ...) are NOT mirrored here — the quiz
 * writes them via trackFunnelEvent directly.
 */
function dbFunnelEventType(event: string): string | null {
  if (event === 'checkout_completed') return 'checkout_completed';
  if (event === 'oto_viewed' || /^oto\d+_viewed$/.test(event)) return 'oto_viewed';
  if (event === 'oto_accepted' || /^oto\d+_purchased$/.test(event)) return 'oto_accepted';
  if (event === 'oto_declined' || /^oto\d+_declined$/.test(event)) return 'oto_declined';
  return null;
}

/**
 * Centralized analytics hook: ONE call site fans out to every sink.
 *
 *   1. the in-memory Zustand store (debug / session state)
 *   2. PostHog product analytics
 *   3. the GTM dataLayer (retargeting pixels)
 *   4. the funnel_events DB mirror (our own conversion data)
 *   5. Meta Pixel + Conversions API (same event ID for deduplication)
 *
 * A second durable server path reports the main purchase from the fulfillment
 * outbox, so payment conversion reporting survives redirects and closed tabs.
 * The deterministic purchase event ID deduplicates all copies at Meta.
 */
export function useAnalytics() {
  const trackEvent = useAnalyticsStore((s) => s.trackEvent);

  const track = useCallback(
    (event: string, metadata?: TrackMetadata) => {
      // Strip CAPI-only fields before forwarding to channels that should
      // never receive raw PII (PostHog, GTM, Meta Pixel browser-side).
      // Preserve undefined-when-absent so downstream channels see the same
      // payload shape they did before CAPI was introduced.
      let sanitized: Record<string, unknown> | undefined;
      if (metadata) {
        // Raw PII must never leak into PostHog/GTM/fbq payloads. CAPI reads
        // the email from the persisted session and hashes it server-side.
        sanitized = { ...metadata };
        delete sanitized.capi_email;
      }

      // 1. In-memory buffer (existing analytics store)
      trackEvent(event, sanitized);
      // 2. PostHog product analytics
      capturePostHogEvent(event, sanitized);
      // 3. GTM dataLayer for retargeting pixels
      pushDataLayerEvent(event, sanitized);
      // 3b. funnel_events DB mirror, so quiz→purchase conversion and the OTO
      // funnel are computable from our own data, not only PostHog. Requires a
      // session_id (funnel_events.session_id is a NOT NULL FK to sessions).
      const dbEventType = dbFunnelEventType(event);
      const dbSessionId =
        typeof sanitized?.session_id === 'string' ? sanitized.session_id : undefined;
      if (dbEventType && dbSessionId) {
        const dbMetadata =
          dbEventType === event ? sanitized : { ...sanitized, source_event: event };
        trackFunnelEvent(dbSessionId, dbEventType, undefined, dbMetadata as Json);
      }
      // 4. Meta Pixel + browser-to-server CAPI mirror (mapped subset only).
      const metaConfig = META_EVENT_MAP[event];
      if (metaConfig) {
        const amountCents =
          typeof sanitized?.amount_cents === 'number' ? sanitized.amount_cents : undefined;
        const currency =
          typeof sanitized?.currency === 'string'
            ? sanitized.currency.toUpperCase()
            : undefined;
        const value =
          typeof sanitized?.value === 'number'
            ? sanitized.value
            : amountCents !== undefined && currency
              ? purchaseEventValue(amountCents, currency)
              : undefined;
        const product =
          typeof sanitized?.product_id === 'string'
            ? sanitized.product_id
            : typeof sanitized?.product === 'string'
              ? sanitized.product
              : undefined;
        const contentName =
          typeof sanitized?.product_name === 'string'
            ? sanitized.product_name
            : undefined;

        // A €0 checkout_completed that opened a REAL subscription (server
        // confirmed via `authorized_trial`) is a free-trial start, not a
        // Purchase. See REPORT_ZERO_VALUE_TRIALS_AS_START_TRIAL.
        const isFreeTrialStart =
          REPORT_ZERO_VALUE_TRIALS_AS_START_TRIAL &&
          metaConfig.name === 'Purchase' &&
          value === 0 &&
          sanitized?.authorized_trial === true &&
          !!currency;
        const effectiveMetaEvent = isFreeTrialStart ? 'StartTrial' : metaConfig.name;

        const suppliedEventId =
          typeof sanitized?.event_id === 'string'
            ? sanitized.event_id
            : typeof sanitized?.eventId === 'string'
              ? sanitized.eventId
              : undefined;

        // Delivery telemetry for money events. Browser Pixel failure is still
        // useful to observe even though CAPI provides the server-side backstop.
        const reportDelivery = (
          pixelFired: boolean,
          skipReason: string | undefined,
          eventId: string | undefined,
        ) => {
          if (metaConfig.name !== 'Purchase') return;
          capturePostHogEvent('meta_pixel_delivery', {
            meta_event: effectiveMetaEvent,
            pixel_fired: pixelFired,
            skip_reason: skipReason,
            event_id: eventId,
            value,
            currency,
            product_category: sanitized?.product_category,
          });
        };

        // Purchase requires value + currency — skip if missing, so a
        // zero-intro upsell cannot fire a $0 Purchase.
        if (
          metaConfig.name === 'Purchase' &&
          !isFreeTrialStart &&
          (value === undefined || value <= 0 || !currency)
        ) {
          reportDelivery(false, 'missing_value_or_currency', suppliedEventId);
        } else {
          // Generate one eventID and use it for BOTH the browser fbq event
          // and the server-side CAPI mirror. Meta dedupes on
          // (event_name, event_id).
          const eventId = suppliedEventId || generateMetaEventId();
          const metaProperties = metaSafeProperties(event, sanitized);
          const pixelProperties = {
            ...metaProperties,
            ...(value !== undefined ? { value } : {}),
            ...(currency ? { currency } : {}),
            ...(product ? { content_ids: [product], content_type: 'product' } : {}),
            ...(contentName ? { content_name: contentName } : {}),
            ...(product ? { num_items: 1 } : {}),
          };
          const pixelFired = metaConfig.custom
            ? trackMetaCustomEvent(effectiveMetaEvent, pixelProperties, { eventID: eventId })
            : trackMetaEvent(effectiveMetaEvent, pixelProperties, { eventID: eventId });

          // CAPI needs a persisted session to derive trusted email, fbp/fbc,
          // IP, user agent and external_id on the server. Events before session
          // creation still reach the browser Pixel and are never blocked.
          const sessionId =
            typeof sanitized?.session_id === 'string' ? sanitized.session_id : undefined;
          if (sessionId) {
            sendCapiFromBrowser({
              eventName: effectiveMetaEvent,
              eventId,
              sessionId,
              customData: {
                ...(value !== undefined ? { value } : {}),
                ...(currency ? { currency } : {}),
                ...(product ? { content_ids: [product], content_type: 'product' } : {}),
                ...(contentName ? { content_name: contentName } : {}),
                ...(typeof sanitized?.step_number === 'number'
                  ? { step_number: sanitized.step_number }
                  : {}),
                ...(event === 'quiz_started' ||
                event === 'step_completed' ||
                event === 'quiz_completed'
                  ? { content_category: 'quiz' }
                  : {}),
              },
            });
          }
          reportDelivery(
            pixelFired,
            pixelFired ? undefined : 'pixel_not_loaded',
            eventId,
          );
        }
      }
    },
    [trackEvent]
  );

  return { track };
}
