import type { SupportAmount, SupportTone } from './types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NormalizedSupportEmail =
  | { ok: true; email: string }
  | { ok: false; error: string };

export function normalizeSupportEmail(value: unknown): NormalizedSupportEmail {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Enter a valid customer email.' };
  }

  const email = value.trim().toLowerCase();
  if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    return { ok: false, error: 'Enter one complete customer email.' };
  }

  if (/[\u0000-\u001f\u007f]/.test(email)) {
    return { ok: false, error: 'The email contains unsupported characters.' };
  }

  return { ok: true, email };
}

export function humanizeSupportValue(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatSupportDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function formatSupportAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatSupportAmounts(amounts: SupportAmount[]): string {
  if (amounts.length === 0) return '—';
  return amounts
    .map(({ amountCents, currency }) => formatSupportAmount(amountCents, currency))
    .join(' + ');
}

export function statusTone(status: string): SupportTone {
  const normalized = status.toLowerCase();
  if (['active', 'completed', 'paid', 'trialing', 'success'].includes(normalized)) {
    return 'positive';
  }
  if (
    ['failed', 'disputed', 'manual_review', 'chargeback', 'past_due'].some((value) =>
      normalized.includes(value),
    )
  ) {
    return 'critical';
  }
  if (['pending', 'processing', 'refunded', 'canceled', 'refused'].includes(normalized)) {
    return 'warning';
  }
  return 'neutral';
}
