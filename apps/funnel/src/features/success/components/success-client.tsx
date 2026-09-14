'use client';

import { useEffect, useRef } from 'react';
import { Link } from '@repo/i18n/navigation';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { CheckCircle, Mail, Download, Play, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFunnelStore } from '@/stores/funnel-store';
import { useQuizStore } from '@/stores/quiz-store';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { PostPaymentNav } from '@/features/auth/components/post-payment-nav';
import { ClaimPurchasePrompt } from '@/features/auth/components/claim-purchase-prompt';
import { AccountCreatedCallout } from './account-created-callout';
import { OrderSummaryCard, type Order } from './order-summary-card';
import { DashboardCta } from './dashboard-cta';

// ─── Animated Section Wrapper ─────────────────────────────────────────────────

interface AnimatedSectionProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}

function AnimatedSection({ children, className, delay = 0 }: AnimatedSectionProps) {
  const ref = useRef<HTMLElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-80px' });
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.section
      ref={ref}
      initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: shouldReduceMotion ? 0 : 30 }}
      transition={{ duration: 0.5, delay }}
      className={className}
    >
      {children}
    </motion.section>
  );
}

// ─── Entitlements ─────────────────────────────────────────────────────────────

export interface Entitlement {
  product_slug: string;
  access_level: string;
  granted_at: string;
  order_id: string | null;
  expires_at: string | null;
}

/**
 * Resolve an entitlement row's `product_slug` to a localized human-readable
 * product name.
 *
 * Strategy:
 *  1. Strip any 2-letter locale prefix from a company code
 *     (e.g. `EN_BRANDPDF4_000000_PDF` → `BRANDPDF4_000000_PDF`).
 *  2. Look up `products.<stripped>` in the `success` namespace.
 *  3. If the key is missing (unknown or legacy slug), fall back to a
 *     prettified slug — never show a raw company code and never crash.
 */
function getEntitlementLabel(
  slug: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const stripped = slug.replace(/^[A-Z]{2}_/, '');
  try {
    // next-intl raises IntlError on missing keys; guard with try/catch.
    return t(`products.${stripped}` as never);
  } catch {
    return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

// ─── Onboarding step icon map ─────────────────────────────────────────────────

const STEP_ICONS = [Mail, Download, Play];

// ─── Success Client ───────────────────────────────────────────────────────────

interface Props {
  orders: Order[];
  email: string | null;
  entitlements?: Entitlement[];
}

export function SuccessClient({ orders, email, entitlements }: Props) {
  const t = useTranslations('success');
  const commonT = useTranslations('common');
  const setStage = useFunnelStore((s) => s.setStage);
  // Payment records can be attached before the browser verifies mailbox ownership.
  const authLinked = useQuizStore((s) => s.authLinked);
  const { track } = useAnalytics();
  const funnelCompletedFired = useRef(false);

  useEffect(() => {
    if (!email) return;
    if (funnelCompletedFired.current) return;
    funnelCompletedFired.current = true;
    setStage('success');
    // funnel_completed is forwarded to PostHog + the GTM dataLayer — never
    // include the raw email here. The user is already PostHog-identified from
    // lead capture, so order_count is all this event needs.
    track('funnel_completed', { order_count: orders.length });
  }, [email, orders.length, setStage, track]);

  // ─── Main Success Page ──────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col bg-si-surface">
      <PostPaymentNav initialEmail={email} hideAvatar />

      {/* ── Hero Section ─────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden bg-gradient-to-br from-si-primary via-si-primary-container to-si-primary px-6 pb-20 pt-16">
        {/* Ambient glow orbs */}
        <div className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-si-secondary/25 blur-[120px]" />
        <div className="pointer-events-none absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-si-secondary-container/20 blur-[120px]" />

        <AnimatedSection className="relative mx-auto flex max-w-2xl flex-col items-center text-center">
          {/* Animated checkmark */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.2 }}
            className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-white/15 ring-4 ring-white/10 backdrop-blur-sm"
          >
            <CheckCircle className="h-10 w-10 text-si-secondary-container" />
          </motion.div>

          {/* Eyebrow */}
          <span className="mb-4 inline-block rounded-full border border-si-secondary-container/30 bg-white/10 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-si-secondary-container backdrop-blur-sm">
            {t('header.eyebrow')}
          </span>

          {/* Headline */}
          <h1 className="mb-4 font-heading text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl">
            <span className="bg-gradient-to-r from-white via-si-secondary-container to-white bg-clip-text text-transparent">
              {t('header.headline')}
            </span>
          </h1>

          <p className="mb-8 max-w-lg text-base leading-relaxed text-white/75">
            {t('header.subheadline')}
          </p>

        </AnimatedSection>
      </div>

      <main className="mx-auto w-full max-w-2xl flex-grow px-4 pb-12 pt-10">
        {/* ── Account Created Callout ───────────────────────────────────── */}
        {email ? (
          <AnimatedSection delay={0.15} className="mb-8">
            <AccountCreatedCallout email={email} />
          </AnimatedSection>
        ) : null}

        {/* ── Order Summary ────────────────────────────────────────────── */}
        <AnimatedSection delay={0.2} className="mb-8">
          <OrderSummaryCard orders={orders} />
        </AnimatedSection>

        {/* ── Ownership Summary  -  Entitlements ─────────────────────────── */}
        {entitlements && entitlements.length > 0 && (
          <AnimatedSection delay={0.25} className="mb-8">
            <div className="rounded-xl border border-si-outline-variant/10 bg-white p-6 shadow-sm">
              <h3 className="mb-4 text-sm font-bold uppercase tracking-wider text-si-on-surface-variant">
                {t('entitlements.heading')}
              </h3>
              <ul className="space-y-3">
                {entitlements.map((ent) => (
                  <li key={ent.product_slug} className="flex items-center justify-between rounded-lg bg-si-surface-container-lowest p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-si-secondary-container/20">
                        <CheckCircle className="h-4 w-4 text-si-secondary" />
                      </div>
                      <span className="text-sm font-semibold text-si-primary">
                        {getEntitlementLabel(ent.product_slug, t)}
                      </span>
                    </div>
                    <span className="rounded-full bg-si-secondary-container px-3 py-1 text-xs font-semibold text-si-on-secondary-container">
                      {ent.access_level === 'trial' ? t('entitlements.trial') : t('entitlements.active')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </AnimatedSection>
        )}

        {/* ── Claim Purchase Prompt ────────────────────────────────────── */}
        {authLinked === false && (
          <AnimatedSection delay={0.35} className="mb-8">
            <ClaimPurchasePrompt />
          </AnimatedSection>
        )}

        {/* ── Dashboard CTA ────────────────────────────────────────────── */}
        <AnimatedSection delay={0.4} className="mb-12">
          <DashboardCta />
        </AnimatedSection>

        {/* ── Next Steps / Onboarding ──────────────────────────────────── */}
        <AnimatedSection delay={0.5} className="mb-12">
          <div className="mb-4 text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-si-secondary">
              {t('onboarding.heading')}
            </p>
            <h3 className="mt-2 font-heading text-xl font-bold text-si-primary">
              {t('onboarding.subtitle')}
            </h3>
          </div>
          <div className="grid gap-4">
            {[
              { step: 1, title: t('onboarding.step1Title'), description: t('onboarding.step1Description') },
              { step: 2, title: t('onboarding.step2Title'), description: t('onboarding.step2Description') },
              { step: 3, title: t('onboarding.step3Title'), description: t('onboarding.step3Description') },
            ].map((step) => {
              const Icon = STEP_ICONS[step.step - 1];
              return (
                <div
                  key={step.step}
                  className="flex items-start gap-4 rounded-xl border border-si-outline-variant/10 bg-white p-5 shadow-sm"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-si-primary-container/10 ring-1 ring-inset ring-si-primary/10">
                    <Icon className="h-5 w-5 text-si-primary" />
                  </div>
                  <div className="flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-si-secondary-container text-[10px] font-bold text-si-on-secondary-container">
                        {step.step}
                      </span>
                      <h4 className="font-bold text-si-primary">{step.title}</h4>
                    </div>
                    <p className="text-sm leading-relaxed text-si-on-surface-variant">{step.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </AnimatedSection>

        {/* ── Guarantee ────────────────────────────────────────────────── */}
        <AnimatedSection delay={0.55} className="mb-12">
          <div className="flex flex-col items-center gap-6 rounded-2xl border border-si-outline-variant/10 bg-white p-8 md:flex-row md:p-10">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-si-secondary-container text-si-on-secondary-container">
              <ShieldCheck className="h-10 w-10" strokeWidth={1.5} />
            </div>
            <div>
              <h3 className="mb-2 font-heading text-lg font-bold text-si-primary">
                {t('guarantee.headline')}
              </h3>
              <p className="mb-2 text-sm leading-relaxed text-si-on-surface-variant">
                {t('guarantee.body')}
              </p>
              <p className="text-sm font-bold text-si-primary">
                {t('guarantee.riskFree')}
              </p>
            </div>
          </div>
        </AnimatedSection>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="w-full bg-slate-50 py-10">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-6 text-center">
          <p className="font-heading font-bold text-si-primary">{t('footer.brand')}</p>
          <div className="flex flex-wrap justify-center gap-6">
            {([
              { key: 'privacy', href: '/privacy' },
              { key: 'terms', href: '/terms' },
              { key: 'cookies', href: '/cookies' },
              { key: 'support', href: '/contact' },
            ] as const).map((link) => (
              <Link
                key={link.key}
                href={link.href}
                className="text-sm text-slate-500 transition-colors hover:text-si-secondary"
              >
                {link.key === 'cookies' ? commonT('footer.cookies') : t(`footer.${link.key}`)}
              </Link>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            {t('footer.copyright')}
          </p>
        </div>
      </footer>
    </div>
  );
}
