import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { drainSolidgateSubscriptionTokenSync } from "@repo/shared/solidgate/subscription-token-sync";
import {
  buildFormMerchantData,
  buildSolidgateOrderId,
  getSolidgateKeys,
  paymentEnvironmentForVercel,
} from "@repo/shared/solidgate";
import { reconcileSolidgateCardUpdate } from "@repo/shared/solidgate/card-update-recovery";
import { routing, localePathSegment } from "@repo/i18n/routing";

/**
 * "Your payment failed — update your card."
 *
 * Solidgate has no SetupIntent, so the form performs a zero-amount auth. The
 * exact issued order is persisted before the form is built. Only the newest
 * unconsumed attempt may replace the vault and subscription tokens; a copied
 * or stale `sg_card_update` return URL is therefore harmless.
 */

export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizedAuthEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function updateCardReturnUrl(request: Request, locale: string, orderId: string): string | null {
  try {
    const configured = process.env.NEXT_PUBLIC_PWA_URL;
    let origin = new URL(request.url).origin;
    if (process.env.VERCEL_ENV === "production") {
      if (!configured) return null;
      const configuredUrl = new URL(configured);
      if (
        configuredUrl.protocol !== "https:" ||
        configuredUrl.username ||
        configuredUrl.password
      ) return null;
      origin = configuredUrl.origin;
    }
    const url = new URL(
      `${localePathSegment(locale as (typeof routing.locales)[number])}/billing/update-payment`,
      origin,
    );
    url.searchParams.set("sg_card_update", orderId);
    return url.toString();
  } catch {
    return null;
  }
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
  return NextResponse.json(
    { ok: false, pending: true, orderId, status, retryAfterMs },
    { status: 202 },
  );
}

function wakeSubscriptionTokenSync(
  paymentEnvironment: "production" | "sandbox",
  userId: string,
): void {
  after(async () => {
    try {
      await drainSolidgateSubscriptionTokenSync({
        paymentEnvironment,
        userId,
        limit: 10,
      });
    } catch (error) {
      // The durable queue remains retryable by the funnel cron. Never turn a
      // successfully vaulted card into a false payment failure here.
      console.error(
        "[solidgate/update-card] background subscription-token sync failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const body = (await request.json().catch(() => ({}))) as {
      orderId?: unknown;
      locale?: unknown;
    };

    const ssr = await createClient();
    const { data: auth } = await ssr.auth.getUser();
    const user = auth?.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabaseAdminClient();
    const rpc = supabase.rpc.bind(supabase) as unknown as UpdateCardRpc;
    const keys = getSolidgateKeys();

    // Step 2: reconcile the exact durable zero-auth and consume it once.
    if (typeof body.orderId === "string" && body.orderId) {
      const orderId = body.orderId;
      const response = await reconcileSolidgateCardUpdate({
        supabase, paymentEnvironment, userId: user.id, orderId,
      });
      if (response.status === 200) wakeSubscriptionTokenSync(paymentEnvironment, user.id);
      return response;
    }

    // Step 1: atomically issue or resume the newest zero-auth form.
    const customerEmail = normalizedAuthEmail(user.email);
    if (!customerEmail) {
      return NextResponse.json(
        { error: "A valid authenticated email is required to update the card" },
        { status: 409 },
      );
    }
    const locale = typeof body.locale === "string" &&
      (routing.locales as readonly string[]).includes(body.locale)
      ? body.locale
      : routing.defaultLocale;
    const candidateOrderId = buildSolidgateOrderId(`u-${user.id}`, "card_update", Date.now());
    const builderToken = randomUUID();
    const { data: openedData, error: openedError } = await rpc(
      "open_solidgate_card_update_attempt",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_candidate_order_id: candidateOrderId,
        p_customer_email: customerEmail,
        p_checkout_locale: locale,
        p_builder_token: builderToken,
      },
    );
    const opened = oneRow(openedData);
    if (openedError || !opened?.solidgate_order_id) {
      console.error(
        "[solidgate/update-card] attempt open failed:",
        openedError?.message ?? "unexpected opener result",
      );
      return NextResponse.json({ error: "Unable to open card update" }, { status: 503 });
    }
    const orderId = opened.solidgate_order_id;
    if (opened.attempt_state === "applying") return pending(orderId, "applying");
    if (opened.merchant_data && typeof opened.merchant_data === "object") {
      return NextResponse.json({ merchantData: opened.merchant_data, orderId });
    }
    if (opened.should_build !== true) return pending(orderId, "building", 500);

    const successUrl = updateCardReturnUrl(request, opened.bound_checkout_locale, orderId);
    if (!successUrl) {
      return NextResponse.json(
        { error: "Payment return URL is not configured" },
        { status: 500 },
      );
    }
    const forwardedIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim();
    const ip = forwardedIp || (process.env.VERCEL_ENV === "production" ? null : "127.0.0.1");
    if (!ip) return NextResponse.json({ error: "Client IP is unavailable" }, { status: 400 });

    const merchantData = await buildFormMerchantData(keys.publicKey, keys.secretKey, {
      order_id: orderId,
      order_description: "Card update",
      amount: 0,
      currency: "EUR",
      customer_account_id: user.id,
      customer_email: opened.bound_customer_email,
      ip_address: ip,
      platform: "WEB",
      success_url: successUrl,
      fail_url: successUrl,
      order_metadata: { user_id: user.id, kind: "card_update" },
    });

    const { data: finalized, error: finalizeError } = await rpc(
      "finalize_solidgate_card_update_attempt",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_attempt_id: opened.attempt_id,
        p_solidgate_order_id: orderId,
        p_builder_token: builderToken,
        p_merchant_data: merchantData,
      },
    );
    if (finalizeError || finalized !== true) {
      console.error(
        "[solidgate/update-card] form finalization failed:",
        finalizeError?.message ?? "lost exact-order builder claim",
      );
      return NextResponse.json({ error: "Unable to initialize card update" }, { status: 503 });
    }

    return NextResponse.json({ merchantData, orderId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[solidgate/update-card]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
