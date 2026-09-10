import { describe, expect, it } from 'vitest';
import { validateEventMetadata } from '../event-metadata';

describe('validateEventMetadata', () => {
  it('accepts stable non-sensitive reporting codes', () => {
    expect(
      validateEventMetadata({ offer_code: 'main', product_id: 'oto1', value: 9.99 }),
    ).toEqual({ ok: true });
  });

  it('rejects sensitive fields at any nesting depth', () => {
    expect(validateEventMetadata({ context: { userEmail: 'test@example.com' } })).toEqual({
      ok: false,
      code: 'SENSITIVE_EVENT_METADATA',
      field: 'metadata.context.userEmail',
    });
    expect(validateEventMetadata({ quiz_answers: { goal: 'private' } }).ok).toBe(false);
    expect(validateEventMetadata({ billing_email: 'test@example.com' }).ok).toBe(false);
    expect(validateEventMetadata({ payment: [{ cardNumber: '4111111111111111' }] }).ok).toBe(
      false,
    );
  });

  it('measures the serialized UTF-8 payload rather than JavaScript characters', () => {
    expect(validateEventMetadata({ note: '🙂'.repeat(2_100) })).toEqual({
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});
