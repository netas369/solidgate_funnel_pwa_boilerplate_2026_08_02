import { NextResponse } from "next/server";

/**
 * Fail-closed shared-secret gate for the CRO read endpoints.
 *
 * These exist so an external CRO dashboard can read per-step drop-off WITHOUT
 * being handed a service-role key to every app's database. The service-role
 * client stays inside this process; the dashboard gets counts over HTTP.
 *
 * Follows apps/pwa/src/app/api/internal/provision-member-area/route.ts, NOT the
 * funnel's solidgate-fulfillment route: the latter's `Boolean(secret && header
 * === secret)` returns 401 when the secret is simply UNSET, which disguises a
 * misconfiguration as an auth failure and sends whoever is debugging it looking
 * for a bad credential. An unset secret is a 500.
 *
 * Returns a response to send, or null when the caller is authorised.
 */
export function authorizeInternalRequest(request: Request): NextResponse | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[internal/cro] INTERNAL_API_SECRET is not set");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }
  if (request.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
