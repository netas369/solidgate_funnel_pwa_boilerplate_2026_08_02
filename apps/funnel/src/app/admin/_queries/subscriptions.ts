// SQL aggregates all rows and retains historical conversions after cancellation.
import { z } from 'zod';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import { convertToEur } from './fx';
import { financialReport, sumInEur } from './revenue';
import type { DateRange } from './_shared';

const Count = z.number().int().nonnegative().safe();
const Status = z.object({ trialing: Count, active: Count, pastDue: Count, canceled: Count, other: Count, total: Count });
const Variants = z.object({ main: Count, special1eur: Count, specialFree: Count, legacy: Count, total: Count });
const Report = z.object({
  cohort_size: Count, converted: Count, rolling_numerator: Count, rolling_denominator: Count, legacy_starts: Count,
  status: Status, variants: Variants,
  addon: z.object({ active_count: Count, unknown_price_count: Count,
    monthly_amounts: z.array(z.object({ currency: z.string(), amount_cents: z.number().int().safe() })),
    sample: z.array(z.object({ user_id: z.string(), expires_at: z.string().nullable(), product_slug: z.string() })),
  }),
});
export interface CohortMetric { cohortSize: number; converted: number; ratePct: number }
export interface RollingMetric { numerator: number; denominator: number; ratePct: number }
export type SubscriptionStatusBreakdown = z.infer<typeof Status>;
export type SubscriptionVariantBreakdown = z.infer<typeof Variants>;
export interface RecurringOtoSnapshot {
  activeCount: number; estimatedMrrEurCents: number | null; renewalRevenueEurCents: number | null;
  unknownPriceCount: number;
  sample: Array<{ user_id: string; expires_at: string | null; product_slug: string }>;
}
async function subscriptionReport({ from, to }: DateRange) {
  const { data, error } = await getSupabaseAdminClient().rpc('get_solidgate_subscription_report', {
    p_environment: 'production', p_from: from, p_to: to,
    p_main_product: SOLIDGATE_PRODUCT_CODES.main, p_addon_product: SOLIDGATE_PRODUCT_CODES.addon,
  });
  if (error) throw new Error(`Subscription report unavailable: ${error.message}`);
  return Report.parse(data);
}
function rate(numerator: number, denominator: number) {
  return denominator ? Math.round(numerator / denominator * 1000) / 10 : 0;
}
function cohort(report: z.infer<typeof Report>): CohortMetric {
  return { cohortSize: report.cohort_size, converted: report.converted, ratePct: rate(report.converted, report.cohort_size) };
}
function rolling(report: z.infer<typeof Report>): RollingMetric {
  return { numerator: report.rolling_numerator, denominator: report.rolling_denominator, ratePct: rate(report.rolling_numerator, report.rolling_denominator) };
}
function addonSnapshot(report: z.infer<typeof Report>, renewalRevenueEurCents: number | null): RecurringOtoSnapshot {
  let estimatedMrrEurCents: number | null = report.addon.unknown_price_count ? null : 0;
  for (const row of report.addon.monthly_amounts) {
    const value = convertToEur(row.amount_cents, row.currency);
    if (value === null || estimatedMrrEurCents === null) estimatedMrrEurCents = null;
    else {
      estimatedMrrEurCents += value;
      if (!Number.isSafeInteger(estimatedMrrEurCents)) throw new Error('MRR exceeds safe precision');
    }
  }
  return { activeCount: report.addon.active_count, estimatedMrrEurCents, renewalRevenueEurCents,
    unknownPriceCount: report.addon.unknown_price_count, sample: report.addon.sample };
}
export async function subscriptionsSummaryInRange(range: DateRange) {
  const [report, money] = await Promise.all([subscriptionReport(range), financialReport(range)]);
  const revenue = sumInEur(money.rows.filter(row => row.billing_type === 'renewal' &&
    [SOLIDGATE_PRODUCT_CODES.addon, 'oto2_addon_weekly'].includes(row.product_slug ?? '')));
  return { cohort: cohort(report), rolling: rolling(report), recurringOto: addonSnapshot(report, revenue),
    statusBreakdown: report.status, variantBreakdown: report.variants, legacyStarts: report.legacy_starts };
}
export async function trialStartsInRange(range: DateRange) { return (await subscriptionReport(range)).cohort_size; }
export async function paidConversionsCohort(range: DateRange) { return cohort(await subscriptionReport(range)); }
export async function paidConversionsRolling(range: DateRange) { return rolling(await subscriptionReport(range)); }
export async function recurringOtoSnapshot(range: DateRange) { return (await subscriptionsSummaryInRange(range)).recurringOto; }
export async function subscriptionStatusBreakdown(range: DateRange) { return (await subscriptionReport(range)).status; }
export async function subscriptionVariantBreakdown(range: DateRange) { return (await subscriptionReport(range)).variants; }
