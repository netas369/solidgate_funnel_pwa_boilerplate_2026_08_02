import { createHash } from 'node:crypto';
import { SOLIDGATE_PRODUCT_CODES } from '../packages/shared/src/solidgate/catalog';

export type LegacyOrder = {
  id: string;
  solidgate_order_id: string;
  session_id: string | null;
  user_id: string | null;
  product_name: string;
  amount_cents: number;
  currency: string;
  solidgate_original_amount_cents: number | null;
  tracking_metadata: Record<string, unknown> | null;
};

export type ProviderTransaction = {
  id?: string;
  status?: string;
  operation?: string;
  amount?: number;
  currency?: string;
  card_token?: { token?: string };
  card?: {
    brand?: string;
    number?: string;
    card_token?: { token?: string };
  };
};

export type ProviderStatus = {
  order_metadata?: Record<string, unknown>;
  order?: {
    order_id?: string;
    customer_email?: string;
    customer_account_id?: string;
    order_description?: string;
    amount?: number;
    currency?: string;
    product_id?: string | null;
    order_metadata?: Record<string, unknown>;
  };
  transaction?: ProviderTransaction;
  transactions?: Record<string, ProviderTransaction>;
  error?: unknown;
};

type NormalizedProviderTransaction = ProviderTransaction & {
  id: string;
  resolvedCardToken: string | null;
  resolvedCardBrand: string | null;
  resolvedCardNumber: string | null;
};

export type ProviderEvidence = {
  email: string;
  accountId: string;
  description: string;
  productId: string | null;
  amountCents: number;
  currency: string;
  orderMetadata: Record<string, unknown>;
  cardToken: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
};

export function orderFingerprint(orderId: string): string {
  return `order-${createHash('sha256').update(orderId, 'utf8').digest('hex').slice(0, 16)}`;
}

export function providerThrottleMs(environment: 'production' | 'sandbox'): number {
  // Sandbox is limited to 10 rps; keep headroom for clock/scheduler jitter.
  return environment === 'sandbox' ? 120 : 60;
}

export function validateOperatorDatabaseUrl(
  value: string,
  supabaseUrl: string,
): URL {
  let databaseUrl: URL;
  let projectUrl: URL;
  try {
    databaseUrl = new URL(value);
    projectUrl = new URL(supabaseUrl);
  } catch {
    throw new Error('Supabase URLs must be valid absolute URLs');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('SUPABASE_DB_URL must be a PostgreSQL URL');
  }

  const username = decodeURIComponent(databaseUrl.username);
  if (username !== 'postgres' && !username.startsWith('postgres.')) {
    throw new Error('SUPABASE_DB_URL must use the postgres project-owner role');
  }

  const localDatabase = ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname);
  const sslMode = databaseUrl.searchParams.get('sslmode');
  if (
    !localDatabase &&
    sslMode !== null &&
    !['require', 'verify-ca', 'verify-full'].includes(sslMode)
  ) {
    throw new Error('remote SUPABASE_DB_URL must require TLS');
  }

  const supabaseHostname = projectUrl.hostname.toLowerCase();
  const projectRef = supabaseHostname.split('.')[0];
  if (supabaseHostname.endsWith('.supabase.co')) {
    const databaseHostname = databaseUrl.hostname.toLowerCase();
    const directDatabase = databaseHostname === `db.${projectRef}.supabase.co`
      && username === 'postgres';
    const officialPooler = databaseHostname.endsWith('.pooler.supabase.com')
      && username === `postgres.${projectRef}`;
    if (!directDatabase && !officialPooler) {
      throw new Error('SUPABASE_DB_URL does not belong to NEXT_PUBLIC_SUPABASE_URL project');
    }
  }
  return databaseUrl;
}

function optionalCardString(value: unknown): { valid: boolean; value: string | null } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function mergeCardValue(
  left: string | null,
  right: string | null,
): { valid: boolean; value: string | null } {
  if (left !== null && right !== null && left !== right) {
    return { valid: false, value: null };
  }
  return { valid: true, value: left ?? right };
}

function normalizedTransactions(status: ProviderStatus): NormalizedProviderTransaction[] | null {
  const byId = new Map<string, NormalizedProviderTransaction>();
  const add = (transaction: ProviderTransaction, mapId?: string): boolean => {
    const parsedId = optionalCardString(transaction.id);
    const id = parsedId.valid ? parsedId.value : null;
    if (!id || (mapId !== undefined && mapId !== id)) return false;
    const directToken = optionalCardString(transaction.card_token?.token);
    const nestedToken = optionalCardString(transaction.card?.card_token?.token);
    const brand = optionalCardString(transaction.card?.brand);
    const number = optionalCardString(transaction.card?.number);
    if (!directToken.valid || !nestedToken.valid || !brand.valid || !number.valid) return false;
    const token = mergeCardValue(directToken.value, nestedToken.value);
    if (!token.valid) return false;

    const normalized: NormalizedProviderTransaction = {
      ...transaction,
      id,
      resolvedCardToken: token.value,
      resolvedCardBrand: brand.value,
      resolvedCardNumber: number.value,
    };
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, normalized);
      return true;
    }
    if (
      existing.amount !== transaction.amount ||
      existing.currency !== transaction.currency ||
      existing.operation !== transaction.operation ||
      existing.status !== transaction.status
    ) return false;
    const mergedToken = mergeCardValue(existing.resolvedCardToken, normalized.resolvedCardToken);
    const mergedBrand = mergeCardValue(existing.resolvedCardBrand, normalized.resolvedCardBrand);
    const mergedNumber = mergeCardValue(existing.resolvedCardNumber, normalized.resolvedCardNumber);
    if (!mergedToken.valid || !mergedBrand.valid || !mergedNumber.valid) return false;
    byId.set(id, {
      ...existing,
      resolvedCardToken: mergedToken.value,
      resolvedCardBrand: mergedBrand.value,
      resolvedCardNumber: mergedNumber.value,
    });
    return true;
  };

  if (status.transaction && !add(status.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(status.transactions ?? {})) {
    if (!transaction || typeof transaction !== 'object' || !add(transaction, mapId)) return null;
  }
  return [...byId.values()];
}

function canonicalMetadata(value: Record<string, unknown> | null): string | null {
  if (!value || Object.values(value).some((entry) => typeof entry !== 'string')) return null;
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}

export function providerEvidence(
  order: LegacyOrder,
  status: ProviderStatus,
): ProviderEvidence | null {
  const provider = status.order;
  const expectedAccountId = order.session_id ?? order.user_id;
  const providerAmount = provider?.amount;
  const providerAmountMatches = order.solidgate_original_amount_cents === null
    ? Number.isSafeInteger(providerAmount) && (providerAmount ?? -1) >= order.amount_cents
    : providerAmount === order.solidgate_original_amount_cents;
  const localPriceId = typeof order.tracking_metadata?.price_id === 'string'
    ? order.tracking_metadata.price_id.trim()
    : '';
  // The main subscription is the only offering Solidgate binds to a catalog
  // product, so it is the only one whose provider product_id we can require.
  // Derived from the catalog so a product rename cannot silently disable this
  // check (which would let a mismatched order reconcile as clean).
  const requiresProductId =
    order.product_name === SOLIDGATE_PRODUCT_CODES.main || localPriceId.length > 0;
  const providerProductId = typeof provider?.product_id === 'string' && provider.product_id.trim()
    ? provider.product_id.trim()
    : null;
  const providerMetadata = status.order_metadata ?? provider?.order_metadata ?? null;
  const transactions = normalizedTransactions(status);
  if (!transactions) return null;
  const cardCandidates = transactions.filter((transaction) => (
    transaction.status === 'success' &&
    transaction.operation === 'auth' &&
    transaction.amount === providerAmount &&
    transaction.currency?.toLowerCase() === provider?.currency?.toLowerCase() &&
    transaction.resolvedCardToken !== null
  ));
  if (cardCandidates.length > 1) return null;
  const cardTransaction = cardCandidates[0] ?? null;
  const cardDigits = cardTransaction?.resolvedCardNumber?.replace(/\D/g, '') ?? '';
  const localMetadata = order.tracking_metadata;

  if (
    !provider ||
    provider.order_id !== order.solidgate_order_id ||
    !expectedAccountId ||
    provider.customer_account_id !== expectedAccountId ||
    typeof provider.customer_email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(provider.customer_email.trim()) ||
    typeof provider.order_description !== 'string' ||
    !providerAmountMatches ||
    !Number.isSafeInteger(providerAmount) ||
    typeof provider.currency !== 'string' ||
    (
      requiresProductId
        ? !localPriceId || providerProductId !== localPriceId
        : providerProductId !== null
    ) ||
    canonicalMetadata(providerMetadata) === null ||
    canonicalMetadata(providerMetadata) !== canonicalMetadata(localMetadata) ||
    provider.currency.toLowerCase() !== order.currency.toLowerCase()
  ) {
    return null;
  }
  return {
    email: provider.customer_email,
    accountId: provider.customer_account_id,
    description: provider.order_description,
    productId: providerProductId,
    amountCents: providerAmount as number,
    currency: provider.currency,
    orderMetadata: providerMetadata as Record<string, unknown>,
    cardToken: cardTransaction?.resolvedCardToken ?? null,
    cardBrand: cardTransaction?.resolvedCardBrand ?? null,
    cardLast4: cardDigits.length >= 4 ? cardDigits.slice(-4) : null,
  };
}
