// Server-only customer evidence query for the admin Support tab.
// The returned contract is an explicit allowlist: raw provider payloads,
// payment tokens, quiz answers, and checkout URLs never cross into the client.

import { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { Database } from '@repo/shared/types/database';
import {
  formatSupportAmount,
  humanizeSupportValue,
  normalizeSupportEmail,
  statusTone,
} from '@/features/admin/support/format';
import type {
  SupportAccount,
  SupportAmount,
  SupportAnswer,
  SupportEntitlement,
  SupportFulfillment,
  SupportOrder,
  SupportRenewal,
  SupportReport,
  SupportSession,
  SupportTimelineEvent,
  SupportWarning,
} from '@/features/admin/support/types';
import { adminConfig } from '@/admin.config';

type SessionTableRow = Database['public']['Tables']['sessions']['Row'];
type SessionRow = Pick<
  SessionTableRow,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'locale'
  | 'source'
  | 'user_id'
  | 'result_segment'
  | 'current_step_id'
  | 'last_oto_step'
  | 'marketing_consent'
>;
type OrderTableRow = Database['public']['Tables']['orders']['Row'];
type OrderRow = Pick<
  OrderTableRow,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'psp'
  | 'payment_environment'
  | 'product_name'
  | 'product_slug'
  | 'status'
  | 'solidgate_payment_status'
  | 'amount_cents'
  | 'solidgate_original_amount_cents'
  | 'solidgate_refunded_amount_cents'
  | 'solidgate_chargeback_amount_cents'
  | 'currency'
  | 'solidgate_order_id'
  | 'solidgate_subscription_id'
  | 'session_id'
  | 'user_id'
  | 'solidgate_customer_email'
  | 'solidgate_checkout_locale'
>;
type EntitlementTableRow = Database['public']['Tables']['entitlements']['Row'];
type EntitlementRow = Pick<
  EntitlementTableRow,
  | 'id'
  | 'product_slug'
  | 'access_level'
  | 'status'
  | 'payment_environment'
  | 'granted_at'
  | 'expires_at'
  | 'revoked_at'
  | 'source'
  | 'order_id'
  | 'solidgate_subscription_id'
>;
type RenewalTableRow = Database['public']['Tables']['renewal_events']['Row'];
type RenewalRow = Pick<
  RenewalTableRow,
  | 'id'
  | 'created_at'
  | 'event_created_at'
  | 'payment_environment'
  | 'product_key'
  | 'status'
  | 'amount_cents'
  | 'gross_amount_cents'
  | 'refunded_amount_cents'
  | 'chargeback_amount_cents'
  | 'currency'
  | 'solidgate_invoice_id'
  | 'solidgate_order_id'
  | 'solidgate_subscription_id'
  | 'subscription_term_number'
>;
type FulfillmentTableRow = Database['public']['Tables']['solidgate_fulfillment_outbox']['Row'];
type FulfillmentRow = Pick<
  FulfillmentTableRow,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'completed_at'
  | 'environment'
  | 'solidgate_order_id'
  | 'effect_type'
  | 'status'
  | 'attempts'
  | 'last_error'
>;
type FunnelEventTableRow = Database['public']['Tables']['funnel_events']['Row'];
type FunnelEventRow = Pick<
  FunnelEventTableRow,
  'id' | 'created_at' | 'event_type' | 'step_number'
>;
type PrefsTableRow = Database['public']['Tables']['user_prefs']['Row'];
type PrefsRow = Pick<
  PrefsTableRow,
  'user_id' | 'locale' | 'country' | 'last_active_at' | 'app_open_count'
>;
type AuditTableRow = Database['public']['Tables']['support_action_audit']['Row'];
type AuditRow = Pick<
  AuditTableRow,
  'id' | 'created_at' | 'completed_at' | 'action' | 'outcome'
>;

const SESSION_FIELDS =
  'id,created_at,updated_at,locale,source,user_id,result_segment,current_step_id,last_oto_step,marketing_consent';
const ORDER_FIELDS =
  'id,created_at,updated_at,psp,payment_environment,product_name,product_slug,status,solidgate_payment_status,amount_cents,solidgate_original_amount_cents,solidgate_refunded_amount_cents,solidgate_chargeback_amount_cents,currency,solidgate_order_id,solidgate_subscription_id,session_id,user_id,solidgate_customer_email,solidgate_checkout_locale';
const ENTITLEMENT_FIELDS =
  'id,product_slug,access_level,status,payment_environment,granted_at,expires_at,revoked_at,source,order_id,solidgate_subscription_id';
const RENEWAL_FIELDS =
  'id,created_at,event_created_at,payment_environment,product_key,status,amount_cents,gross_amount_cents,refunded_amount_cents,chargeback_amount_cents,currency,solidgate_invoice_id,solidgate_order_id,solidgate_subscription_id,subscription_term_number';
const FULFILLMENT_FIELDS =
  'id,created_at,updated_at,completed_at,environment,solidgate_order_id,effect_type,status,attempts,last_error';
const FUNNEL_EVENT_FIELDS = 'id,created_at,event_type,step_number';
const PREFS_FIELDS = 'user_id,locale,country,last_active_at,app_open_count';
const AUDIT_FIELDS = 'id,created_at,completed_at,action,outcome';

const MAX_MATCHES = adminConfig.support.maxMatchesPerSource;
const CAPTURED_ORDER_STATUSES = new Set([
  'completed',
  'trialing',
  'active',
  'past_due',
  'refunded',
  'disputed',
]);

function warn(
  warnings: SupportWarning[],
  source: string,
  error: { message: string } | null | undefined,
) {
  if (!error) return;
  console.error(`[admin/support] ${source}:`, error.message);
  warnings.push({
    source,
    message: `${source} could not be read. The report may be incomplete.`,
  });
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function sumAmounts(rows: Array<{ currency: string; amountCents: number }>): SupportAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = row.currency.toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + row.amountCents);
  }
  return [...totals.entries()]
    .map(([currency, amountCents]) => ({ currency, amountCents }))
    .filter((item) => item.amountCents > 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function isActiveEntitlement(row: EntitlementRow, now: number): boolean {
  if (row.status !== 'active' || row.revoked_at) return false;
  return !row.expires_at || Date.parse(row.expires_at) > now;
}

function buildAnswer(params: {
  status: SupportReport['customerStatus'];
  activeEntitlements: number;
  activeSubscriptions: number;
  paymentFailures: number;
  operationalFailures: number;
}): SupportAnswer {
  if (params.status === 'not-found') {
    return {
      headline: 'No customer history was found',
      detail: 'Check the exact email address. No database records matched this lookup.',
      tone: 'neutral',
    };
  }
  if (params.status === 'ambiguous') {
    return {
      headline: 'Multiple customer identities need review',
      detail: 'Evidence is shown, but support actions are disabled until the identity is resolved.',
      tone: 'critical',
    };
  }
  if (params.operationalFailures > 0) {
    return {
      headline: 'Customer found with a fulfillment issue',
      detail: 'Review the Operations evidence before telling the customer that access is ready.',
      tone: 'critical',
    };
  }
  if (params.paymentFailures > 0 && params.activeEntitlements === 0) {
    return {
      headline: 'Customer found, but access is not active',
      detail: 'The history contains a failed or interrupted payment and no active entitlement.',
      tone: 'warning',
    };
  }
  if (params.activeEntitlements > 0 || params.activeSubscriptions > 0) {
    return {
      headline: 'Customer found with active access',
      detail: 'The stored access and payment evidence currently agree.',
      tone: 'positive',
    };
  }
  return {
    headline: 'Customer history found',
    detail: 'Review the payment and access sections for the complete status.',
    tone: 'neutral',
  };
}

function buildSummary(report: Omit<SupportReport, 'summary'>): string {
  const lines = [
    `Customer support report for ${report.email}`,
    `Generated: ${report.generatedAt} (UTC)`,
    `Status: ${report.answer.headline}`,
    `Accounts: ${report.accounts.length}; sessions: ${report.sessions.length}; orders: ${report.orders.length}`,
    `Active subscriptions: ${report.metrics.activeSubscriptions}; active entitlements: ${report.metrics.activeEntitlements}`,
  ];
  if (report.metrics.captured.length > 0) {
    lines.push(
      `Captured: ${report.metrics.captured
        .map((item) => formatSupportAmount(item.amountCents, item.currency))
        .join(' + ')}`,
    );
  }
  if (report.metrics.refunded.length > 0) {
    lines.push(
      `Refunded / charged back: ${report.metrics.refunded
        .map((item) => formatSupportAmount(item.amountCents, item.currency))
        .join(' + ')}`,
    );
  }
  if (report.metrics.paymentFailures > 0) {
    lines.push(`Payment issues: ${report.metrics.paymentFailures}`);
  }
  if (report.metrics.operationalFailures > 0) {
    lines.push(`Fulfillment issues: ${report.metrics.operationalFailures}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`Partial-data warnings: ${report.warnings.length}`);
  }
  return lines.join('\n');
}

export async function lookupCustomerSupportReport(rawEmail: unknown): Promise<SupportReport> {
  const normalized = normalizeSupportEmail(rawEmail);
  if (!normalized.ok) throw new Error(normalized.error);

  const email = normalized.email;
  const emailHash = createHash('sha256').update(email).digest('hex');
  const admin = getSupabaseAdminClient();
  const warnings: SupportWarning[] = [];

  const [exactSessionsResult, rpcResult] = await Promise.all([
    admin.from('sessions').select(SESSION_FIELDS).eq('email', email).limit(MAX_MATCHES),
    admin.rpc('find_auth_user_id_by_email', { p_email: email }),
  ]);
  warn(warnings, 'Funnel sessions', exactSessionsResult.error);
  warn(warnings, 'Authentication identity', rpcResult.error);

  const exactSessions = (exactSessionsResult.data ?? []) as SessionRow[];
  const userIds = new Set(
    exactSessions.map((row) => row.user_id).filter((value): value is string => Boolean(value)),
  );
  if (typeof rpcResult.data === 'string' && rpcResult.data) userIds.add(rpcResult.data);
  const userIdList = [...userIds].slice(0, 10);

  const [linkedSessionsResult, prefsResult, authResults] = await Promise.all([
    userIdList.length > 0
      ? admin.from('sessions').select(SESSION_FIELDS).in('user_id', userIdList).limit(MAX_MATCHES)
      : Promise.resolve({ data: [] as SessionRow[], error: null }),
    userIdList.length > 0
      ? admin.from('user_prefs').select(PREFS_FIELDS).in('user_id', userIdList)
      : Promise.resolve({ data: [] as PrefsRow[], error: null }),
    Promise.all(userIdList.map((userId) => admin.auth.admin.getUserById(userId))),
  ]);
  warn(warnings, 'Linked sessions', linkedSessionsResult.error);
  warn(warnings, 'Account preferences', prefsResult.error);

  const sessionRows = uniqueById([
    ...exactSessions,
    ...((linkedSessionsResult.data ?? []) as SessionRow[]),
  ]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const sessionIds = sessionRows.map((row) => row.id);

  const [emailOrdersResult, sessionOrdersResult, userOrdersResult, entitlementsResult, eventsResult, auditResult] =
    await Promise.all([
      admin
        .from('orders')
        .select(ORDER_FIELDS)
        .eq('solidgate_customer_email', email)
        .limit(MAX_MATCHES),
      sessionIds.length > 0
        ? admin.from('orders').select(ORDER_FIELDS).in('session_id', sessionIds).limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as OrderRow[], error: null }),
      userIdList.length > 0
        ? admin.from('orders').select(ORDER_FIELDS).in('user_id', userIdList).limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as OrderRow[], error: null }),
      userIdList.length > 0
        ? admin.from('entitlements').select(ENTITLEMENT_FIELDS).in('user_id', userIdList).limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as EntitlementRow[], error: null }),
      sessionIds.length > 0
        ? admin
            .from('funnel_events')
            .select(FUNNEL_EVENT_FIELDS)
            .in('session_id', sessionIds)
            .order('created_at', { ascending: false })
            .limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as FunnelEventRow[], error: null }),
      admin
        .from('support_action_audit')
        .select(AUDIT_FIELDS)
        .eq('customer_email_hash', emailHash)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

  warn(warnings, 'Orders by checkout email', emailOrdersResult.error);
  warn(warnings, 'Orders by session', sessionOrdersResult.error);
  warn(warnings, 'Orders by account', userOrdersResult.error);
  warn(warnings, 'Entitlements', entitlementsResult.error);
  warn(warnings, 'Funnel events', eventsResult.error);
  warn(warnings, 'Support audit', auditResult.error);

  const orderRows = uniqueById([
    ...((emailOrdersResult.data ?? []) as OrderRow[]),
    ...((sessionOrdersResult.data ?? []) as OrderRow[]),
    ...((userOrdersResult.data ?? []) as OrderRow[]),
  ]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const entitlementRows = ((entitlementsResult.data ?? []) as EntitlementRow[]).sort(
    (a, b) => Date.parse(b.granted_at) - Date.parse(a.granted_at),
  );
  const subscriptionIds = [
    ...new Set(
      orderRows
        .map((row) => row.solidgate_subscription_id)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const providerOrderIds = [
    ...new Set(
      orderRows
        .map((row) => row.solidgate_order_id)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const [renewalsBySubscriptionResult, renewalsByOrderResult, fulfillmentResult] =
    await Promise.all([
      subscriptionIds.length > 0
        ? admin
            .from('renewal_events')
            .select(RENEWAL_FIELDS)
            .in('solidgate_subscription_id', subscriptionIds)
            .limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as RenewalRow[], error: null }),
      providerOrderIds.length > 0
        ? admin
            .from('renewal_events')
            .select(RENEWAL_FIELDS)
            .in('solidgate_order_id', providerOrderIds)
            .limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as RenewalRow[], error: null }),
      providerOrderIds.length > 0
        ? admin
            .from('solidgate_fulfillment_outbox')
            .select(FULFILLMENT_FIELDS)
            .in('solidgate_order_id', providerOrderIds)
            .limit(MAX_MATCHES)
        : Promise.resolve({ data: [] as FulfillmentRow[], error: null }),
    ]);
  warn(warnings, 'Renewals by subscription', renewalsBySubscriptionResult.error);
  warn(warnings, 'Renewals by order', renewalsByOrderResult.error);
  warn(warnings, 'Fulfillment operations', fulfillmentResult.error);

  const renewalRows = uniqueById([
    ...((renewalsBySubscriptionResult.data ?? []) as RenewalRow[]),
    ...((renewalsByOrderResult.data ?? []) as RenewalRow[]),
  ]).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const fulfillmentRows = ((fulfillmentResult.data ?? []) as FulfillmentRow[]).sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  const prefs = new Map(
    ((prefsResult.data ?? []) as PrefsRow[]).map((row) => [row.user_id, row]),
  );

  const accounts: SupportAccount[] = authResults.flatMap((result) => {
    if (result.error || !result.data.user) {
      warn(warnings, 'Authentication details', result.error);
      return [];
    }
    const user = result.data.user;
    const preference = prefs.get(user.id);
    const providerList = Array.isArray(user.app_metadata.providers)
      ? user.app_metadata.providers.filter((value): value is string => typeof value === 'string')
      : user.identities?.map((identity) => identity.provider) ?? [];
    return [
      {
        userId: user.id,
        email: user.email ?? email,
        createdAt: user.created_at ?? null,
        emailConfirmedAt: user.email_confirmed_at ?? null,
        lastSignInAt: user.last_sign_in_at ?? null,
        authProviders: [...new Set(providerList)],
        locale: preference?.locale ?? null,
        country: preference?.country ?? null,
        lastActiveAt: preference?.last_active_at ?? null,
        appOpenCount: preference?.app_open_count ?? 0,
      },
    ];
  });

  const sessions: SupportSession[] = sessionRows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    locale: row.locale,
    source: row.source,
    userId: row.user_id,
    resultSegment: row.result_segment,
    currentStepId: row.current_step_id,
    lastOtoStep: row.last_oto_step,
    marketingConsent: row.marketing_consent,
  }));

  const orders: SupportOrder[] = orderRows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provider: row.psp,
    environment: row.payment_environment,
    product: row.product_name,
    productCode: row.product_slug,
    status: row.status,
    providerStatus: row.solidgate_payment_status,
    amountCents: row.solidgate_original_amount_cents ?? row.amount_cents,
    refundedAmountCents: row.solidgate_refunded_amount_cents,
    chargebackAmountCents: row.solidgate_chargeback_amount_cents,
    currency: row.currency,
    orderId: row.solidgate_order_id,
    subscriptionId: row.solidgate_subscription_id,
    sessionId: row.session_id,
    userId: row.user_id,
    customerEmail: row.solidgate_customer_email,
    locale: row.solidgate_checkout_locale,
  }));

  const now = Date.now();
  const entitlements: SupportEntitlement[] = entitlementRows.map((row) => ({
    id: row.id,
    productCode: row.product_slug,
    accessLevel: row.access_level,
    status: row.status,
    environment: row.payment_environment,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    source: row.source,
    orderId: row.order_id,
    subscriptionId: row.solidgate_subscription_id,
    active: isActiveEntitlement(row, now),
  }));

  const renewals: SupportRenewal[] = renewalRows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    eventCreatedAt: row.event_created_at,
    environment: row.payment_environment,
    productCode: row.product_key,
    status: row.status,
    amountCents: row.gross_amount_cents ?? row.amount_cents,
    refundedAmountCents: row.refunded_amount_cents,
    chargebackAmountCents: row.chargeback_amount_cents,
    currency: row.currency,
    invoiceId: row.solidgate_invoice_id,
    orderId: row.solidgate_order_id,
    subscriptionId: row.solidgate_subscription_id,
    termNumber: row.subscription_term_number,
  }));

  const fulfillment: SupportFulfillment[] = fulfillmentRows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    environment: row.environment,
    orderId: row.solidgate_order_id,
    effect: row.effect_type,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error
      ? 'A background operation reported an error. Check the server logs for details.'
      : null,
  }));

  const supportActions = ((auditResult.data ?? []) as AuditRow[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    action: row.action,
    outcome: row.outcome,
  }));

  const activeSubscriptions = orders.filter(
    (row) =>
      Boolean(row.subscriptionId) && ['active', 'trialing', 'past_due'].includes(row.status),
  ).length;
  const activeEntitlements = entitlements.filter((row) => row.active).length;
  const paymentFailures =
    orders.filter(
      (row) =>
        ['failed', 'past_due', 'disputed'].includes(row.status) ||
        row.chargebackAmountCents > 0,
    ).length +
    renewals.filter((row) =>
      ['voided', 'disputed'].includes(row.status) || row.chargebackAmountCents > 0,
    ).length;
  const operationalFailures = fulfillment.filter((row) =>
    ['failed', 'manual_review'].includes(row.status),
  ).length;

  const captured = sumAmounts([
    ...orders
      .filter((row) => CAPTURED_ORDER_STATUSES.has(row.status))
      .map((row) => ({ currency: row.currency, amountCents: row.amountCents })),
    ...renewals
      .filter((row) => ['paid', 'partially_refunded', 'refunded', 'disputed'].includes(row.status))
      .map((row) => ({ currency: row.currency, amountCents: row.amountCents })),
  ]);
  const refunded = sumAmounts([
    ...orders.map((row) => ({
      currency: row.currency,
      amountCents: row.refundedAmountCents + row.chargebackAmountCents,
    })),
    ...renewals.map((row) => ({
      currency: row.currency,
      amountCents: row.refundedAmountCents + row.chargebackAmountCents,
    })),
  ]);

  const timeline: SupportTimelineEvent[] = [
    ...accounts.flatMap((account) =>
      account.createdAt
        ? [
            {
              id: `account:${account.userId}`,
              at: account.createdAt,
              category: 'account' as const,
              label: 'Account created',
              detail: account.authProviders.join(', ') || null,
              tone: 'neutral' as const,
            },
          ]
        : [],
    ),
    ...sessions.map((session) => ({
      id: `session:${session.id}`,
      at: session.createdAt,
      category: 'session' as const,
      label: 'Funnel session started',
      detail: `${humanizeSupportValue(session.source)} · ${session.locale.toUpperCase()}`,
      tone: 'neutral' as const,
    })),
    ...((eventsResult.data ?? []) as FunnelEventRow[]).map((event) => ({
      id: `event:${event.id}`,
      at: event.created_at,
      category: 'funnel' as const,
      label: humanizeSupportValue(event.event_type),
      detail: event.step_number == null ? null : `Step ${event.step_number}`,
      tone: event.event_type.includes('completed') ? ('positive' as const) : ('neutral' as const),
    })),
    ...orders.map((order) => ({
      id: `order:${order.id}`,
      at: order.createdAt,
      category: 'payment' as const,
      label: `Payment ${humanizeSupportValue(order.status).toLowerCase()}`,
      detail: `${order.product} · ${formatSupportAmount(order.amountCents, order.currency)}`,
      tone: statusTone(order.status),
    })),
    ...entitlements.map((entitlement) => ({
      id: `entitlement:${entitlement.id}`,
      at: entitlement.grantedAt,
      category: 'access' as const,
      label: entitlement.active ? 'Access granted' : `Access ${entitlement.status}`,
      detail: entitlement.productCode,
      tone: entitlement.active ? ('positive' as const) : statusTone(entitlement.status),
    })),
    ...renewals.map((renewal) => ({
      id: `renewal:${renewal.id}`,
      at: renewal.eventCreatedAt ?? renewal.createdAt,
      category: 'payment' as const,
      label: `Renewal ${humanizeSupportValue(renewal.status).toLowerCase()}`,
      detail: formatSupportAmount(renewal.amountCents, renewal.currency),
      tone: statusTone(renewal.status),
    })),
    ...fulfillment.map((item) => ({
      id: `fulfillment:${item.id}`,
      at: item.completedAt ?? item.updatedAt,
      category: 'operations' as const,
      label: `Fulfillment ${humanizeSupportValue(item.status).toLowerCase()}`,
      detail: humanizeSupportValue(item.effect),
      tone: statusTone(item.status),
    })),
    ...supportActions.map((item) => ({
      id: `support:${item.id}`,
      at: item.completedAt ?? item.createdAt,
      category: 'support' as const,
      label: humanizeSupportValue(item.action),
      detail: humanizeSupportValue(item.outcome),
      tone: statusTone(item.outcome),
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 150);

  const customerStatus: SupportReport['customerStatus'] =
    accounts.length > 1 || userIdList.length > 1
      ? 'ambiguous'
      : accounts.length === 1
        ? 'registered'
        : orders.length > 0
          ? 'checkout-only'
          : sessions.length > 0
            ? 'lead-only'
            : 'not-found';
  const metrics = {
    captured,
    refunded,
    sessions: sessions.length,
    orders: orders.length,
    activeSubscriptions,
    activeEntitlements,
    paymentFailures,
    operationalFailures,
  };
  const answer = buildAnswer({
    status: customerStatus,
    activeEntitlements,
    activeSubscriptions,
    paymentFailures,
    operationalFailures,
  });

  const reportWithoutSummary: Omit<SupportReport, 'summary'> = {
    version: 1,
    generatedAt: new Date().toISOString(),
    email,
    emailHash,
    customerStatus,
    answer,
    accounts,
    sessions,
    orders,
    entitlements,
    renewals,
    fulfillment,
    supportActions,
    timeline,
    metrics,
    warnings,
    mutationsAllowed: customerStatus === 'registered' && accounts.length === 1,
  };

  return {
    ...reportWithoutSummary,
    summary: buildSummary(reportWithoutSummary),
  };
}
