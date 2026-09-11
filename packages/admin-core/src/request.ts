export type AdminJsonRequestResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413 | 415; error: string };

export async function readSameOriginAdminJson(
  request: Request,
  maxBodyBytes: number,
): Promise<AdminJsonRequestResult> {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');

  if (fetchSite === 'cross-site') {
    return { ok: false, status: 400, error: 'Cross-site requests are not allowed.' };
  }
  if (!origin || origin !== requestUrl.origin) {
    return { ok: false, status: 400, error: 'A valid same-origin request is required.' };
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, error: 'JSON request required.' };
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return { ok: false, status: 413, error: 'Request is too large.' };
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBodyBytes) {
    return { ok: false, status: 413, error: 'Request is too large.' };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: 'Malformed JSON request.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'A JSON object is required.' };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
