import { NextResponse } from "next/server";

/**
 * First-purchase provisioning hook.
 *
 * The Solidgate webhook POSTs here once, right after the first successful
 * purchase creates the member's account. It is the one place to do the
 * expensive "prepare this member's content" work that must NOT run inside the
 * webhook's own request (a slow provisioning there delays the webhook ACK and
 * earns a provider retry — which is how you end up provisioning twice).
 *
 * It ships as a working no-op stub on purpose: the boilerplate has nothing to
 * provision, and a route that 404s makes the webhook log an error on every
 * single purchase.
 *
 * TODO(new product): do the real work here. Two rules worth keeping:
 *   1. Be IDEMPOTENT. The webhook may retry, and a member may buy twice.
 *      Key the work on userId and no-op when it is already done.
 *   2. Stay fast, or hand off to a queue. The caller uses a short timeout and
 *      treats a slow response as a failure.
 *
 * Auth: shared secret, same as every other /api/internal route. This endpoint
 * is server-to-server only — never call it from the browser, the secret would
 * be in the bundle.
 */

export const dynamic = "force-dynamic";

interface ProvisionBody {
  userId?: unknown;
  locale?: unknown;
}

export async function POST(request: Request) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    // Fail closed: an unset secret must never mean "everyone is authorised".
    console.error("[provision-member-area] INTERNAL_API_SECRET is not set");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }
  if (request.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as ProvisionBody;
  const userId = typeof body.userId === "string" ? body.userId : null;
  if (!userId) {
    return NextResponse.json({ error: "missing_user_id" }, { status: 400 });
  }

  // TODO(new product): provision here.
  return NextResponse.json({ ok: true, provisioned: false });
}
