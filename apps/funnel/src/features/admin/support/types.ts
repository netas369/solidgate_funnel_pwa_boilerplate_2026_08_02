/**
 * Sanitized support-report contract shared by the server query and admin UI.
 *
 * Keep this shape deliberately boring: never add card data, provider tokens,
 * checkout URLs, raw quiz answers, request metadata, or Supabase service data.
 */
import type { AdminSupportActionKey } from '@repo/admin-core/config';

export type SupportTone = 'positive' | 'warning' | 'critical' | 'neutral';

export interface SupportWarning {
  source: string;
  message: string;
}

export interface SupportAccount {
  userId: string;
  email: string;
  createdAt: string | null;
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
  authProviders: string[];
  locale: string | null;
  country: string | null;
  lastActiveAt: string | null;
  appOpenCount: number;
}

export interface SupportSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  locale: string;
  source: string;
  userId: string | null;
  resultSegment: string | null;
  currentStepId: string | null;
  lastOtoStep: string | null;
  marketingConsent: boolean | null;
}

export interface SupportOrder {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  environment: string;
  product: string;
  productCode: string | null;
  status: string;
  providerStatus: string | null;
  amountCents: number;
  refundedAmountCents: number;
  chargebackAmountCents: number;
  currency: string;
  orderId: string | null;
  subscriptionId: string | null;
  sessionId: string | null;
  userId: string | null;
  customerEmail: string | null;
  locale: string | null;
}

export interface SupportEntitlement {
  id: string;
  productCode: string;
  accessLevel: string;
  status: string;
  environment: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  source: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  active: boolean;
}

export interface SupportRenewal {
  id: string;
  createdAt: string;
  eventCreatedAt: string | null;
  environment: string;
  productCode: string | null;
  status: string;
  amountCents: number;
  refundedAmountCents: number;
  chargebackAmountCents: number;
  currency: string;
  invoiceId: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  termNumber: number | null;
}

export interface SupportFulfillment {
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  environment: string;
  orderId: string;
  effect: string;
  status: string;
  attempts: number;
  lastError: string | null;
}

export interface SupportActionEvent {
  id: string;
  createdAt: string;
  completedAt: string | null;
  action: string;
  outcome: string;
}

export interface SupportTimelineEvent {
  id: string;
  at: string;
  category: 'account' | 'session' | 'funnel' | 'payment' | 'access' | 'operations' | 'support';
  label: string;
  detail: string | null;
  tone: SupportTone;
}

export interface SupportAmount {
  currency: string;
  amountCents: number;
}

export interface SupportMetrics {
  captured: SupportAmount[];
  refunded: SupportAmount[];
  sessions: number;
  orders: number;
  activeSubscriptions: number;
  activeEntitlements: number;
  paymentFailures: number;
  operationalFailures: number;
}

export interface SupportAnswer {
  headline: string;
  detail: string;
  tone: SupportTone;
}

export interface SupportReport {
  version: 1;
  generatedAt: string;
  email: string;
  emailHash: string;
  customerStatus: 'registered' | 'checkout-only' | 'lead-only' | 'not-found' | 'ambiguous';
  answer: SupportAnswer;
  accounts: SupportAccount[];
  sessions: SupportSession[];
  orders: SupportOrder[];
  entitlements: SupportEntitlement[];
  renewals: SupportRenewal[];
  fulfillment: SupportFulfillment[];
  supportActions: SupportActionEvent[];
  timeline: SupportTimelineEvent[];
  metrics: SupportMetrics;
  warnings: SupportWarning[];
  summary: string;
  mutationsAllowed: boolean;
}

export type SupportActionName = AdminSupportActionKey;

export interface SupportActionResult {
  action: SupportActionName;
  message: string;
}
