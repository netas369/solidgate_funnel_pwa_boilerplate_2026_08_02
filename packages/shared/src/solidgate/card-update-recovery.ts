import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '../supabase/admin';
import { getSolidgateKeys, SolidgateClient } from './index';
import type { PaymentEnvironment } from '../payment-environment';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMINAL_PROVIDER_STATUSES = new Set(["auth_failed", "declined", "void_ok"]);
const INVALID_ZERO_AUTH_STATUSES = new Set(["settle_ok", "partial_settled", "refunded"]);
const PENDING_PROVIDER_STATUSES = new Set([
  "created",
  "processing",
  "3ds_verify",
]);

const SOLIDGATE_ORIGINAL_PAYMENT_METHODS = new Set([
  "card",
  "apple-pay",
  "google-pay",
  "network-token",
  "click-to-pay",
] as const);
type SolidgateOriginalPaymentMethod =
  | "card"
  | "apple-pay"
  | "google-pay"
  | "network-token"
  | "click-to-pay";

type SolidgateCardToken = {
  token?: string;
  original_payment_method?: unknown;
};

function normalizedAuthEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

type CardTransaction = {
  id?: string;
  amount?: number;
  currency?: string;
  operation?: string;
  status?: string;
  card_token?: SolidgateCardToken;
  card?: { brand?: string; number?: string; card_token?: SolidgateCardToken };
};

type ReusableCardTransaction = {
  id: string;
  token: string;
  brand: string | null;
  number: string | null;
  originalPaymentMethod: "card" | "network-token";
};

interface OrderStatus {
  order?: {
    order_id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    customer_account_id?: string;
    customer_email?: string;
    payment_method?: unknown;
  };
  transaction?: CardTransaction;
  transactions?: Record<string, CardTransaction>;
}

type RpcError = { message: string } | null;
type UpdateCardRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: RpcError }>;

type CardUpdateAttempt = {
  attempt_id: string;
  solidgate_order_id?: string;
  bound_customer_email: string;
  bound_checkout_locale: string;
  source_created_at?: string;
  attempt_state: "building" | "issued" | "applying" | "completed" | "failed";
  merchant_data?: unknown;
  is_current?: boolean;
  is_new?: boolean;
  should_build?: boolean;
};

function oneRow(value: unknown): CardUpdateAttempt | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  return row && typeof row === "object" ? row as CardUpdateAttempt : null;
}

function pending(orderId: string, status: string | null, retryAfterMs = 2_000) {
  return Response.json(
    { ok: false, pending: true, orderId, status, retryAfterMs },
    { status: 202 },
  );
}

function providerBindingMatches(
  status: NonNullable<OrderStatus["order"]>,
  orderId: string,
  userId: string,
  customerEmail: string,
): boolean {
  return (
    status.order_id === orderId &&
    status.customer_account_id === userId &&
    normalizedAuthEmail(status.customer_email) === customerEmail &&
    status.amount === 0 &&
    status.currency?.toLowerCase() === "eur"
  );
}

function optionalNonEmptyString(value: unknown): { valid: boolean; value: string | null } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function mergeConsistentValue<T extends string>(
  left: T | null,
  right: T | null,
): { valid: boolean; value: T | null } {
  if (left !== null && right !== null && left !== right) {
    return { valid: false, value: null };
  }
  return { valid: true, value: left ?? right };
}

function optionalOriginalPaymentMethod(value: unknown): {
  valid: boolean;
  value: SolidgateOriginalPaymentMethod | null;
} {
  if (value == null) return { valid: true, value: null };
  if (
    typeof value !== "string"
    || !SOLIDGATE_ORIGINAL_PAYMENT_METHODS.has(value as SolidgateOriginalPaymentMethod)
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value: value as SolidgateOriginalPaymentMethod };
}

function optionalOrderPaymentMethod(value: unknown): {
  valid: boolean;
  value: SolidgateOriginalPaymentMethod | null;
} {
  if (value === "token") return { valid: true, value: null };
  return optionalOriginalPaymentMethod(value);
}

function reusableCardTransaction(status: OrderStatus): ReusableCardTransaction | null {
  type NormalizedTransaction = Omit<ReusableCardTransaction, "originalPaymentMethod"> & {
    originalPaymentMethod: SolidgateOriginalPaymentMethod | null;
    amount?: number;
    currency?: string;
    operation?: string;
    status?: string;
  };

  const orderPaymentMethod = optionalOrderPaymentMethod(status.order?.payment_method);
  if (!orderPaymentMethod.valid) return null;
  const byId = new Map<string, NormalizedTransaction>();
  const add = (transaction: CardTransaction, mapId?: string): boolean => {
    const id = optionalNonEmptyString(transaction.id);
    if (!id.valid || !id.value || (mapId !== undefined && mapId !== id.value)) return false;

    const directToken = optionalNonEmptyString(transaction.card_token?.token);
    const nestedToken = optionalNonEmptyString(transaction.card?.card_token?.token);
    const directOriginalPaymentMethod = optionalOriginalPaymentMethod(
      transaction.card_token?.original_payment_method,
    );
    const nestedOriginalPaymentMethod = optionalOriginalPaymentMethod(
      transaction.card?.card_token?.original_payment_method,
    );
    const brand = optionalNonEmptyString(transaction.card?.brand);
    const number = optionalNonEmptyString(transaction.card?.number);
    if (
      !directToken.valid
      || !nestedToken.valid
      || !directOriginalPaymentMethod.valid
      || !nestedOriginalPaymentMethod.valid
      || !brand.valid
      || !number.valid
    ) return false;

    const token = mergeConsistentValue(directToken.value, nestedToken.value);
    const tokenOriginalPaymentMethod = mergeConsistentValue(
      directOriginalPaymentMethod.value,
      nestedOriginalPaymentMethod.value,
    );
    const originalPaymentMethod = tokenOriginalPaymentMethod.valid
      ? mergeConsistentValue(tokenOriginalPaymentMethod.value, orderPaymentMethod.value)
      : { valid: false, value: null };
    if (!token.valid || !originalPaymentMethod.valid) return false;

    const normalized: NormalizedTransaction = {
      id: id.value,
      amount: transaction.amount,
      currency: transaction.currency,
      operation: transaction.operation,
      status: transaction.status,
      token: token.value ?? "",
      brand: brand.value,
      number: number.value,
      originalPaymentMethod: originalPaymentMethod.value,
    };
    const existing = byId.get(id.value);
    if (!existing) {
      byId.set(id.value, normalized);
      return true;
    }
    if (
      existing.amount !== normalized.amount ||
      existing.currency !== normalized.currency ||
      existing.operation !== normalized.operation ||
      existing.status !== normalized.status
    ) return false;

    const mergedToken = mergeConsistentValue(existing.token || null, normalized.token || null);
    const mergedBrand = mergeConsistentValue(existing.brand, normalized.brand);
    const mergedNumber = mergeConsistentValue(existing.number, normalized.number);
    const mergedOriginalPaymentMethod = mergeConsistentValue(
      existing.originalPaymentMethod,
      normalized.originalPaymentMethod,
    );
    if (
      !mergedToken.valid
      || !mergedBrand.valid
      || !mergedNumber.valid
      || !mergedOriginalPaymentMethod.valid
    ) return false;
    byId.set(id.value, {
      ...existing,
      token: mergedToken.value ?? "",
      brand: mergedBrand.value,
      number: mergedNumber.value,
      originalPaymentMethod: mergedOriginalPaymentMethod.value,
    });
    return true;
  };

  if (status.transaction && !add(status.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(status.transactions ?? {})) {
    if (!transaction || typeof transaction !== "object" || !add(transaction, mapId)) return null;
  }

  const candidates = [...byId.values()].filter((transaction): transaction is (
    NormalizedTransaction & { originalPaymentMethod: "card" | "network-token" }
  ) => (
    transaction.status === "success" &&
    transaction.operation === "auth" &&
    transaction.amount === 0 &&
    transaction.currency?.toLowerCase() === "eur" &&
    transaction.token.length > 0 &&
    (
      transaction.originalPaymentMethod === "card"
      || transaction.originalPaymentMethod === "network-token"
    )
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

/** Reconcile one durable zero-auth; never issues another form or charge. */
export async function reconcileSolidgateCardUpdate({
  supabase, paymentEnvironment, userId, orderId, provider,
}: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  paymentEnvironment: PaymentEnvironment;
  userId: string;
  orderId: string;
  provider?: Pick<SolidgateClient, 'status'>;
}): Promise<Response> {
  const rpc = supabase.rpc.bind(supabase) as unknown as UpdateCardRpc;
  const { data: attemptData, error: attemptError } = await rpc(
    "get_solidgate_card_update_attempt",
    {
      p_payment_environment: paymentEnvironment,
      p_user_id: userId,
      p_solidgate_order_id: orderId,
    },
  );
  const attempt = oneRow(attemptData);
  if (attemptError) {
    console.error("[solidgate/update-card] attempt read failed:", attemptError.message);
    return Response.json({ error: "Unable to verify card update" }, { status: 503 });
  }
  if (!attempt || attempt.is_current !== true) {
    return Response.json(
      { error: "Card-update attempt is stale or does not belong to this user" },
      { status: 409 },
    );
  }
  if (attempt.attempt_state === "completed") {
    return Response.json({ ok: true, repointed: 0, accessRestored: false });
  }
  if (attempt.attempt_state === "failed" || attempt.attempt_state === "building") {
    return Response.json({ error: "Card update is not confirmable" }, { status: 409 });
  }

  const client = provider ?? new SolidgateClient(getSolidgateKeys());
  const status = await client.status<OrderStatus>({ order_id: orderId });
  const providerOrder = status.order;
  if (!providerOrder) return pending(orderId, null);
  if (!providerBindingMatches(
    providerOrder,
    orderId,
    userId,
    attempt.bound_customer_email,
  )) {
    return Response.json(
      { error: "Provider card-update binding mismatch" },
      { status: 409 },
    );
  }

  const providerStatus = providerOrder.status ?? null;
  if (providerStatus !== "auth_ok") {
    const terminal = Boolean(providerStatus && (
      TERMINAL_PROVIDER_STATUSES.has(providerStatus) ||
      INVALID_ZERO_AUTH_STATUSES.has(providerStatus)
    ));
    const { data: recorded, error: recordError } = await rpc(
      "record_solidgate_card_update_attempt_status",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: userId,
        p_solidgate_order_id: orderId,
        p_provider_status: providerStatus,
        p_terminal: terminal,
      },
    );
    if (terminal) {
      if (recordError || recorded !== true) {
        console.error(
          "[solidgate/update-card] terminal state persistence failed:",
          recordError?.message ?? "lost exact-order state",
        );
        return Response.json(
          { error: "Unable to record terminal card update" },
          { status: 503 },
        );
      }
      return Response.json(
        { error: "Card not authorised", status: providerStatus, terminal: true },
        { status: 402 },
      );
    }
    // Unknown non-terminal states are ambiguous too. Never turn a delayed
    // 3DS/provider transition into a false decline.
    return pending(
      orderId,
      providerStatus,
      providerStatus && PENDING_PROVIDER_STATUSES.has(providerStatus) ? 2_000 : 5_000,
    );
  }

  const transaction = reusableCardTransaction(status);
  const token = transaction?.token;
  if (!token) return pending(orderId, providerStatus);

  const applyToken = randomUUID();
  const { data: claimData, error: claimError } = await rpc(
    "claim_solidgate_card_update_attempt",
    {
      p_payment_environment: paymentEnvironment,
      p_user_id: userId,
      p_solidgate_order_id: orderId,
      p_apply_token: applyToken,
    },
  );
  if (claimError) {
    console.error("[solidgate/update-card] consume claim failed:", claimError.message);
    return Response.json({ error: "Unable to apply card update" }, { status: 503 });
  }
  if (claimData === "completed") {
    return Response.json({ ok: true, repointed: 0, accessRestored: false });
  }
  if (claimData === "busy") return pending(orderId, providerStatus);
  if (claimData !== "acquired") {
    return Response.json({ error: "Card-update attempt is no longer current" }, { status: 409 });
  }

  const releaseClaim = async () => {
    await rpc("release_solidgate_card_update_attempt", {
      p_payment_environment: paymentEnvironment,
      p_user_id: userId,
      p_solidgate_order_id: orderId,
      p_apply_token: applyToken,
      p_provider_status: providerStatus,
    });
  };

  const maskedNumber = transaction.number;
  const last4 = maskedNumber?.replace(/\D/g, "").slice(-4) || null;
  const { data: vaultResult, error: vaultError } = await rpc(
    "write_solidgate_account_vault_with_method",
    {
      p_payment_environment: paymentEnvironment,
      p_user_id: userId,
      p_source_kind: "card_update",
      p_source_id: attempt.attempt_id,
      p_source_claim_token: applyToken,
      p_card_token: token,
      p_card_brand: transaction.brand,
      p_card_last4: last4,
      p_original_payment_method: transaction.originalPaymentMethod,
    },
  );
  if (vaultError || !["written", "same", "stale"].includes(String(vaultResult))) {
    await releaseClaim();
    console.error(
      "[solidgate/update-card] vault update failed:",
      vaultError?.message ?? `unexpected vault result: ${String(vaultResult)}`,
    );
    return pending(orderId, providerStatus);
  }

  const { data: completed, error: completeError } = await rpc(
    "complete_solidgate_card_update_attempt",
    {
      p_payment_environment: paymentEnvironment,
      p_user_id: userId,
      p_solidgate_order_id: orderId,
      p_apply_token: applyToken,
      p_provider_status: providerStatus,
    },
  );
  if (completeError || completed !== true) {
    console.error(
      "[solidgate/update-card] consume completion failed:",
      completeError?.message ?? "lost exact-order completion claim",
    );
    return pending(orderId, providerStatus);
  }

  // Updating a token is not payment proof. Access is restored only by a
  // later successful renewal/order webhook.
  return Response.json({
    ok: true,
    repointed: 0,
    syncPending: true,
    accessRestored: false,
  });
}

/** Browser-independent recovery, driven by the existing internal cron. */
export async function drainSolidgateCardUpdates(params: {
  paymentEnvironment: PaymentEnvironment;
  limit?: number;
  supabase?: ReturnType<typeof getSupabaseAdminClient>;
  provider?: Pick<SolidgateClient, 'status'>;
}): Promise<{ checked: number; completed: number; pending: number; failed: number }> {
  const supabase = params.supabase ?? getSupabaseAdminClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as UpdateCardRpc;
  const { data, error } = await rpc('list_due_solidgate_card_update_attempts', {
    p_payment_environment: params.paymentEnvironment,
    p_limit: Math.min(Math.max(params.limit ?? 10, 1), 10),
  });
  if (error) throw new Error(`Card-update recovery read failed: ${error.message}`);
  const result = { checked: 0, completed: 0, pending: 0, failed: 0 };
  // Status calls have a 12s transport deadline. Run this bounded batch in
  // parallel so ten slow provider responses cannot consume a 60s cron window
  // before the token-sync and fulfillment queues get their turn.
  await Promise.all((Array.isArray(data) ? data.slice(0, 10) : []).map(async (row) => {
    if (typeof row?.user_id !== 'string' || typeof row?.solidgate_order_id !== 'string') return;
    result.checked++;
    try {
      const response = await reconcileSolidgateCardUpdate({
        supabase, paymentEnvironment: params.paymentEnvironment,
        userId: row.user_id, orderId: row.solidgate_order_id, provider: params.provider,
      });
      const body = await response.json();
      if (response.ok && body.ok === true && body.pending !== true) result.completed++;
      else if (response.status === 202) result.pending++;
      else result.failed++;
    } catch (error) {
      result.failed++;
      console.error('[solidgate/card-update-recovery] reconciliation failed:',
        error instanceof Error ? error.message : 'unknown error');
    }
  }));
  return result;
}
