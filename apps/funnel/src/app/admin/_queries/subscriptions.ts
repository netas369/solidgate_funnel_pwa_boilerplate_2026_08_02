// Subscription aggregations for the admin Subscriptions tab.
// - paidConversionsCohort enforces the 7-day gate AND requires ≥1 renewal_events row.
// - paidConversionsRolling uses orders.updated_at for status transitions.
// - recurringOtoSnapshot uses TWO Supabase queries combined in TypeScript
//   (PostgREST .or() with ISO timestamps is unsafe — the colons break it).
// Server-only; never import from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { PRICE_MAP, type ProductId } from '@repo/shared/price-map';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import { parseSolidgateOrderId } from '@repo/shared/solidgate';
import { convertToEur } from './fx';
import type { DateRange } from './_shared';

// A main-plan subscription order is identified by its catalog offering code on
// orders.product_slug. Kept as a PostgREST filter STRING (rather than .eq) so a
// product with several main offerings can add clauses here without touching
// every query below. Landmine: the string must stay STATIC — never interpolate
// an ISO timestamp into .or(), the colons break PostgREST's parser.
const MAIN_SUB_FILTER = `product_slug.eq.${SOLIDGATE_PRODUCT_CODES.main}`;

// The recurring OTO (the one upsell slot that starts a subscription rather than
// charging once). Both the entitlement product_slug and the ProductId form are
// matched, because entitlements written by different code paths use either.
const RECURRING_OTO_SLUG_PATTERN = `%${SOLIDGATE_PRODUCT_CODES.addon}%`;
const RECURRING_OTO_PRODUCT_ID: ProductId = 'oto2_addon_weekly';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Solidgate writes the order row BEFORE payment ('pending') and a declined
// attempt stays 'failed' (retries mint a fresh order). Neither ever was a
// subscription, so status views must not count them.
const NEVER_A_SUB_STATUSES = '("pending","failed")';

export interface CohortMetric {
  cohortSize: number;
  converted: number;
  ratePct: number;
}

export interface RollingMetric {
  numerator: number;
  denominator: number;
  ratePct: number;
}

export interface RecurringOtoSnapshot {
  activeCount: number;
  estimatedMrrEurCents: number;
  renewalRevenueEurCents: number;
  sample: Array<{ user_id: string; expires_at: string | null; product_slug: string }>;
}

/** Current-status snapshot of plan subscription orders started in a window. */
export interface SubscriptionStatusBreakdown {
  /** In free trial — not charged yet. */
  trialing: number;
  /** Trial converted — actively paying. */
  active: number;
  /** A payment failed — past due / in retry. */
  pastDue: number;
  /** Subscription ended. */
  canceled: number;
  /** Any other order status (refunded / disputed / …). */
  other: number;
  /** trialing + active + pastDue + canceled + other. */
  total: number;
}

// Every state a real subscription can be in. 'past_due' matters: a sub whose
// rebill is in dunning still started as a trial — leaving it out undercounts
// trial starts and shrinks conversion denominators while the buyer is retried.
const SUB_LIFECYCLE_STATUSES = ['trialing', 'active', 'past_due', 'canceled'];

export async function trialStartsInRange({ from, to }: DateRange): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('payment_environment', 'production')
    .or(MAIN_SUB_FILTER)
    .in('status', SUB_LIFECYCLE_STATUSES)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error) {
    console.error('[admin/subs] trialStartsInRange failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

export async function paidConversionsCohort({
  from,
  to,
}: DateRange): Promise<CohortMetric> {
  const admin = getSupabaseAdminClient();

  // Step 1: trials that started in window.
  const { data: trials, error: trialErr } = await admin
    .from('orders')
    .select('solidgate_subscription_id,created_at,status')
    .eq('payment_environment', 'production')
    .or(MAIN_SUB_FILTER)
    .in('status', SUB_LIFECYCLE_STATUSES)
    .gte('created_at', from)
    .lt('created_at', to);
  if (trialErr || !trials) {
    console.error('[admin/subs] cohort trial fetch failed:', trialErr?.message);
    return { cohortSize: 0, converted: 0, ratePct: 0 };
  }
  const cohortSize = trials.length;
  if (cohortSize === 0) return { cohortSize: 0, converted: 0, ratePct: 0 };

  // Steps 2-4: for each converted-eligible trial, find its first renewal_events
  // row and apply the 7d gate. 'past_due' stays eligible: a sub in dunning
  // already paid its first renewal, and the payment that converted it does not
  // un-happen.
  const activeTrials = trials.filter(
    (t) =>
      (t.status === 'active' || t.status === 'past_due') &&
      !!t.solidgate_subscription_id,
  );
  const solidgateIds = activeTrials
    .map((t) => t.solidgate_subscription_id as string | null)
    .filter((id): id is string => !!id);

  // subscription id → earliest renewal timestamp.
  const firstRenewalMs = new Map<string, number>();
  const recordRenewal = (subId: unknown, createdAt: unknown) => {
    if (typeof subId !== 'string' || typeof createdAt !== 'string') return;
    const ms = new Date(createdAt).getTime();
    if (!Number.isFinite(ms)) return;
    const prev = firstRenewalMs.get(subId);
    if (prev === undefined || ms < prev) firstRenewalMs.set(subId, ms);
  };

  const solidgateRenewals = solidgateIds.length
    ? await admin
        .from('renewal_events')
        .select('solidgate_subscription_id,created_at')
        .eq('payment_environment', 'production')
        .in('solidgate_subscription_id', solidgateIds)
    : { data: [] as Array<Record<string, unknown>>, error: null };
  for (const r of solidgateRenewals.data ?? []) {
    recordRenewal(
      (r as Record<string, unknown>).solidgate_subscription_id,
      (r as Record<string, unknown>).created_at,
    );
  }

  let converted = 0;
  for (const t of activeTrials) {
    const subId = t.solidgate_subscription_id as string | null;
    if (!subId) continue;
    const firstPaidMs = firstRenewalMs.get(subId);
    if (firstPaidMs === undefined) continue;
    const trialStartMs = new Date(t.created_at as string).getTime();
    if (firstPaidMs - trialStartMs >= SEVEN_DAYS_MS) {
      converted++;
    }
  }

  const ratePct = Math.round((converted / cohortSize) * 1000) / 10;
  return { cohortSize, converted, ratePct };
}

export async function paidConversionsRolling({
  from,
  to,
}: DateRange): Promise<RollingMetric> {
  const admin = getSupabaseAdminClient();

  const [{ count: num }, { count: denom }] = await Promise.all([
    admin
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('payment_environment', 'production')
      .or(MAIN_SUB_FILTER)
      .eq('status', 'active')
      .gte('updated_at', from)
      .lt('updated_at', to),
    admin
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('payment_environment', 'production')
      .or(MAIN_SUB_FILTER)
      .in('status', SUB_LIFECYCLE_STATUSES)
      .gte('created_at', from)
      .lt('created_at', to),
  ]);

  const numerator = num ?? 0;
  const denominator = denom ?? 0;
  const ratePct =
    denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
  return { numerator, denominator, ratePct };
}

/**
 * Per-active-subscription monthly run-rate for the recurring OTO, in EUR cents.
 *
 * Uses the canonical EN price (a per-locale figure would need an
 * entitlement→locale join). The recurring OTO bills WEEKLY, so the weekly price
 * is annualised to a monthly figure — quoting the raw weekly amount understates
 * the run-rate by ~4.33x.
 *
 * TODO(new product): if your recurring OTO bills monthly, drop the ×52/12.
 */
function canonicalRecurringOtoMonthlyCents(): number {
  const map = (
    PRICE_MAP as unknown as Record<string, Record<string, { amountCents: number }>>
  )[RECURRING_OTO_PRODUCT_ID];
  if (!map) return 0;
  const sample = map['en'] ?? Object.values(map)[0];
  const weeklyCents = sample?.amountCents ?? 0;
  return Math.round((weeklyCents * 52) / 12);
}

/**
 * Active-subscription snapshot for the recurring OTO slot.
 *
 * TWO Supabase queries combined in TypeScript (no PostgREST .or() with ISO
 * timestamps).
 *
 * - Query A pulls active + non-revoked entitlements (no timestamp in .or()).
 * - "Not expired" is computed in TS by comparing each row's expires_at to Date.now().
 * - Query B pulls windowed renewal_events for the renewal-revenue sum.
 *
 * Both queries run in parallel; merge in TS.
 */
export async function recurringOtoSnapshot({
  from,
  to,
}: DateRange): Promise<RecurringOtoSnapshot> {
  const admin = getSupabaseAdminClient();

  // Query A: recurring-OTO entitlements with status='active' AND revoked_at IS NULL.
  // .or() contains ONLY static strings (no timestamps). Safe for PostgREST.
  const queryA = admin
    .from('entitlements')
    .select('user_id, expires_at, product_slug')
    .eq('payment_environment', 'production')
    .eq('status', 'active')
    .is('revoked_at', null)
    .or(
      `product_slug.ilike.${RECURRING_OTO_SLUG_PATTERN},product_slug.eq.${RECURRING_OTO_PRODUCT_ID}`,
    );

  // Query B: windowed renewal_events (no product filter at the DB layer;
  // TS-filter after). .gte / .lt accept ISO timestamps (values, not filter
  // strings), so they are safe.
  const queryB = admin
    .from('renewal_events')
    .select('amount_cents, currency, product_key')
    .eq('payment_environment', 'production')
    .gte('created_at', from)
    .lt('created_at', to);

  const [{ data: ents, error: entErr }, { data: renewals, error: renErr }] =
    await Promise.all([queryA, queryB]);

  if (entErr) {
    console.error('[admin/subs] recurring-OTO entitlements fetch failed:', entErr.message);
  }
  if (renErr) {
    console.error('[admin/subs] recurring-OTO renewals fetch failed:', renErr.message);
  }

  // TS-side "not expired" filter — replaces the broken PostgREST .or() form
  // that embedded an ISO timestamp via the GT operator.
  const nowMs = Date.now();
  const activeAndNotExpired = (ents ?? []).filter((row) => {
    const exp = row.expires_at as string | null;
    if (exp === null) return true;
    const expMs = new Date(exp).getTime();
    return Number.isFinite(expMs) && expMs > nowMs;
  });

  const activeCount = activeAndNotExpired.length;
  const sample = activeAndNotExpired.slice(0, 5).map((row) => ({
    user_id: row.user_id as string,
    expires_at: (row.expires_at as string | null) ?? null,
    product_slug: row.product_slug as string,
  }));

  const estimatedMrrEurCents = activeCount * canonicalRecurringOtoMonthlyCents();

  const renewalRevenueEurCents = (renewals ?? [])
    .filter((r) => {
      const key = (r.product_key as string) ?? '';
      return (
        key.includes(SOLIDGATE_PRODUCT_CODES.addon) ||
        key === RECURRING_OTO_PRODUCT_ID
      );
    })
    .reduce(
      (sum, r) =>
        sum +
        convertToEur(
          (r.amount_cents as number) ?? 0,
          (r.currency as string) ?? 'eur',
        ),
      0,
    );

  return {
    activeCount,
    estimatedMrrEurCents,
    renewalRevenueEurCents,
    sample,
  };
}

/**
 * Where each plan subscription in the window came from. Every checkout tier
 * shares one product_slug (the main offering code), so the split lives in the
 * Solidgate order id, whose grammar is {sessionId}:{tier}:{attempt} — trial1-4
 * are the main quiz funnel; special_1eur / special_free are the abandonment
 * landing pages. Rows with no parseable Solidgate order id count as 'legacy'.
 */
export interface SubscriptionVariantBreakdown {
  main: number;
  special1eur: number;
  specialFree: number;
  legacy: number;
  total: number;
}

export async function subscriptionVariantBreakdown({
  from,
  to,
}: DateRange): Promise<SubscriptionVariantBreakdown> {
  const empty: SubscriptionVariantBreakdown = {
    main: 0,
    special1eur: 0,
    specialFree: 0,
    legacy: 0,
    total: 0,
  };
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('orders')
    .select('solidgate_order_id')
    .eq('payment_environment', 'production')
    .or(MAIN_SUB_FILTER)
    .in('status', SUB_LIFECYCLE_STATUSES)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error('[admin/subs] subscriptionVariantBreakdown failed:', error?.message);
    return empty;
  }
  const out: SubscriptionVariantBreakdown = { ...empty, total: data.length };
  for (const row of data) {
    const orderId = row.solidgate_order_id as string | null;
    const slug = orderId ? parseSolidgateOrderId(orderId)?.offeringSlug ?? null : null;
    if (!slug) out.legacy++;
    else if (slug === 'special_1eur') out.special1eur++;
    else if (slug === 'special_free') out.specialFree++;
    else out.main++;
  }
  return out;
}

/**
 * Current-status breakdown of plan (trial) subscriptions whose order was
 * created in the window. Each subscription is one orders row and the webhook
 * updates its status in place (trialing → active → past_due → canceled), so
 * grouping by status is a clean snapshot of where each subscription stands now.
 * Pending/failed rows are checkout attempts that never became a subscription
 * and are excluded outright.
 */
export async function subscriptionStatusBreakdown({
  from,
  to,
}: DateRange): Promise<SubscriptionStatusBreakdown> {
  const empty: SubscriptionStatusBreakdown = {
    trialing: 0,
    active: 0,
    pastDue: 0,
    canceled: 0,
    other: 0,
    total: 0,
  };
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('orders')
    .select('status')
    .eq('payment_environment', 'production')
    .or(MAIN_SUB_FILTER)
    .not('status', 'in', NEVER_A_SUB_STATUSES)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error(
      '[admin/subs] subscriptionStatusBreakdown failed:',
      error?.message,
    );
    return empty;
  }
  const out: SubscriptionStatusBreakdown = { ...empty, total: data.length };
  for (const row of data) {
    switch (row.status) {
      case 'trialing':
        out.trialing++;
        break;
      case 'active':
        out.active++;
        break;
      case 'past_due':
        out.pastDue++;
        break;
      case 'canceled':
        out.canceled++;
        break;
      default:
        out.other++;
    }
  }
  return out;
}
