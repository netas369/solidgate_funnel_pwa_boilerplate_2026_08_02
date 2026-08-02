import {
  buildOto3PdfEmailHtml,
  getOto3PdfEmailSubject,
  type Oto3PdfEmailParams,
} from './oto3-pdf-email';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface SendOto3PdfEmailParams extends Oto3PdfEmailParams {
  resendApiKey: string;
  fromAddress: string;
  /** Stable per-order key: makes an ambiguous network retry non-duplicating. */
  idempotencyKey?: string;
}

export interface PreparedOto3PdfEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export type Oto3PdfEmailSendResult =
  | { status: 'sent' }
  | { status: 'definite_failure'; error: string }
  | { status: 'ambiguous'; error: string };

function isAmbiguousResendResponse(status: number): boolean {
  // A 5xx response does not prove that Resend rejected the email before queueing it.
  if (status >= 500) return true;

  // Every idempotency conflict is ambiguous. `concurrent_idempotent_requests`
  // may have a competing request in flight, while `invalid_idempotent_request`
  // means the same key was previously used with another body; that prior body
  // may already have sent. Clearing the fence in either case risks a duplicate.
  if (status === 409) return true;

  // A request timeout is likewise unable to establish whether delivery began.
  return status === 408;
}

export function prepareOto3PdfEmail(
  params: Oto3PdfEmailParams & { fromAddress: string },
): PreparedOto3PdfEmail {
  return {
    from: params.fromAddress,
    to: params.email,
    subject: getOto3PdfEmailSubject(params.productLabel, params.locale),
    html: buildOto3PdfEmailHtml(params),
  };
}

export async function sendPreparedOto3PdfEmail(params: {
  resendApiKey: string;
  message: PreparedOto3PdfEmail;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const result = await sendPreparedOto3PdfEmailDetailed(params);
  return result.status === 'sent';
}

export async function sendPreparedOto3PdfEmailDetailed(params: {
  resendApiKey: string;
  message: PreparedOto3PdfEmail;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<Oto3PdfEmailSendResult> {
  const { resendApiKey, message, idempotencyKey, signal } = params;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      // The durable worker persists this exact object before the first send,
      // so retries never reuse an idempotency key with a changed HTML body.
      body: JSON.stringify(message),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => 'no body');
      console.error('[oto3-pdf-email] Resend API error:', res.status, body);
      return {
        status: isAmbiguousResendResponse(res.status)
          ? 'ambiguous'
          : 'definite_failure',
        error: `Resend HTTP ${res.status}: ${body}`,
      };
    }
    console.log('[oto3-pdf-email] sent to', message.to);
    return { status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[oto3-pdf-email] fetch failed:', message);
    return { status: 'ambiguous', error: message };
  }
}

export async function sendOto3PdfEmail(params: SendOto3PdfEmailParams): Promise<boolean> {
  const { resendApiKey, fromAddress, email, locale, productLabel, idempotencyKey } = params;
  return sendPreparedOto3PdfEmail({
    resendApiKey,
    idempotencyKey,
    message: prepareOto3PdfEmail({ ...params, fromAddress, email, locale, productLabel }),
  });
}
