const MAX_EVENT_METADATA_BYTES = 8 * 1024;

const SENSITIVE_KEYS = new Set([
  'answer',
  'answers',
  'answer_value',
  'quiz_answer',
  'quiz_answers',
  'quiz_result',
  'result',
  'result_payload',
  'email',
  'email_address',
  'user_email',
  'capi_email',
  'ip',
  'ip_address',
  'client_ip',
  'authorization',
  'cookie',
  'secret',
  'access_token',
  'refresh_token',
  'auth_token',
  'card_number',
  'payment_method',
  'payment_token',
  'pan',
  'cvv',
  'cvc',
]);

export type EventMetadataValidation =
  | { ok: true }
  | { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'SENSITIVE_EVENT_METADATA'; field?: string };

function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith('_email') ||
    normalized.endsWith('_answer') ||
    normalized.endsWith('_answers') ||
    normalized.endsWith('_token') ||
    normalized.endsWith('_secret') ||
    normalized.endsWith('_cookie') ||
    normalized.endsWith('_ip')
  );
}

export function validateEventMetadata(metadata: Record<string, unknown>): EventMetadataValidation {
  const serialized = JSON.stringify(metadata);
  if (new TextEncoder().encode(serialized).length > MAX_EVENT_METADATA_BYTES) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
  }

  const pending: Array<{ value: unknown; path: string }> = [{ value: metadata, path: 'metadata' }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !current.value || typeof current.value !== 'object') continue;

    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) => {
        pending.push({ value, path: `${current.path}[${index}]` });
      });
      continue;
    }

    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      const path = `${current.path}.${key}`;
      if (isSensitiveKey(key)) {
        return { ok: false, code: 'SENSITIVE_EVENT_METADATA', field: path };
      }
      pending.push({ value, path });
    }
  }

  return { ok: true };
}
