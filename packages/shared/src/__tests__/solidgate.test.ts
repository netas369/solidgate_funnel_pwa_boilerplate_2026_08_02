import { describe, expect, it } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import { signSolidgatePayload, verifySolidgateSignature } from '../solidgate/signature';
import { buildFormMerchantData, encryptPaymentIntent } from '../solidgate/form';
import { buildSolidgateOrderId, parseSolidgateOrderId } from '../solidgate/order-id';

// Fixed vectors generated from the OFFICIAL @solidgate/node-sdk v1.4.1
// (node -e with Api._generateSignature / formMerchantData). If these tests
// fail, our implementation diverged from Solidgate's - do not "fix" the
// vectors, fix the implementation.
const PUB = 'api_pk_test_vector_public_key';
const SEC = 'api_sk_test_vector_secret_0123456789abcdefghij';
const BODY = '{"order_id":"vector-1","amount":100,"currency":"USD"}';
const SDK_SIGNATURE =
  'YzZmMjI4MWY4ZWEyNDg2ZWM5ZTMyODM4NzI3NWFiMmFlN2ZlY2YxYmZhYjNjMDlmY2E4ZjI2Y2NiMzEzOThlNzMxMTNkOTU3ODNiNTQ0YzM3MjgwMjQ0NjExMzJiZmNlNGM5MzU3Mjg1ZTBlNGI5MTNmZTkyMWEzODcyMjI0OGE=';
// One concrete formMerchantData output (IV is random, so this exact ciphertext
// can only be VERIFIED, not reproduced): signature must validate against it.
const SDK_ENCRYPTED_INTENT =
  'DkiqvH-0X2ff0JbUHSWEbw1vEku8EWDlXVtw8EAXi_kQxSB_2r3lnbMQv1Z3hTJjAxSD2YgwQSoCn5zy84reEAZeL8jwa08e09zzg5TtDiE=';
const SDK_ENCRYPTED_INTENT_SIGNATURE =
  'ODhkNzdmNTAwYzUyYjNiNjlhNTQ3OTYwM2FjNzlhMjc5MDg0ZmNmMThhM2RhNTEwNjczMjIzYjUwZTk4NDZhZjhhNWFlZWVhMWEwNDkzZWM0OGY3Zjc2YTljMzFiZTlmMmQyZTE2MjU2YWY2YTg3ZDk4NGI2ZjM4MzJkZjljZTI=';

function decryptWithNode(secretKey: string, encrypted: string): string {
  const raw = Buffer.from(encrypted.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const decipher = createDecipheriv('aes-256-cbc', secretKey.substring(0, 32), raw.subarray(0, 16));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString();
}

describe('solidgate signature', () => {
  it('matches the official SDK byte-for-byte', async () => {
    expect(await signSolidgatePayload(PUB, SEC, BODY)).toBe(SDK_SIGNATURE);
  });

  it('verifies an SDK-produced signature over an SDK-encrypted intent', async () => {
    expect(
      await verifySolidgateSignature(PUB, SEC, SDK_ENCRYPTED_INTENT, SDK_ENCRYPTED_INTENT_SIGNATURE),
    ).toBe(true);
  });

  it('rejects tampered bodies and truncated/foreign signatures', async () => {
    expect(await verifySolidgateSignature(PUB, SEC, SDK_ENCRYPTED_INTENT + 'x', SDK_ENCRYPTED_INTENT_SIGNATURE)).toBe(false);
    expect(await verifySolidgateSignature(PUB, SEC, SDK_ENCRYPTED_INTENT, SDK_SIGNATURE)).toBe(false);
    expect(await verifySolidgateSignature(PUB, SEC, SDK_ENCRYPTED_INTENT, 'short')).toBe(false);
  });
});

describe('solidgate form merchantData', () => {
  const intent = {
    order_id: 'vector-1',
    order_description: 'test',
    amount: 100,
    currency: 'USD',
  };

  it('encrypts so the SDK-equivalent decryption recovers the intent JSON', async () => {
    const encrypted = await encryptPaymentIntent(SEC, intent);
    expect(JSON.parse(decryptWithNode(SEC, encrypted))).toEqual(intent);
    // Solidgate's URL-safe variant: '+'/'/' replaced, '=' padding kept
    expect(encrypted).not.toMatch(/[+/]/);
  });

  it('produces merchantData whose signature verifies over the encrypted payload', async () => {
    const md = await buildFormMerchantData(PUB, SEC, intent);
    expect(md.merchant).toBe(PUB);
    expect(await verifySolidgateSignature(PUB, SEC, md.paymentIntent, md.signature)).toBe(true);
    expect(JSON.parse(decryptWithNode(SEC, md.paymentIntent))).toEqual(intent);
  });
});

describe('solidgate order id grammar', () => {
  it('round-trips', () => {
    const id = buildSolidgateOrderId('3fa85f64-5717-4562-b3fc-2c963f66afa6', 'oto1_lifetime', 2);
    expect(id).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6:oto1_lifetime:2');
    expect(parseSolidgateOrderId(id)).toEqual({
      sessionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      offeringSlug: 'oto1_lifetime',
      attempt: 2,
    });
  });

  it('defaults attempt to 1 and rejects bad inputs', () => {
    expect(buildSolidgateOrderId('s', 'trial1')).toBe('s:trial1:1');
    expect(() => buildSolidgateOrderId('a:b', 'trial1')).toThrow();
    expect(() => buildSolidgateOrderId('s', 'trial1', 0)).toThrow();
    expect(() => buildSolidgateOrderId('s', 'x'.repeat(300))).toThrow();
  });

  it('returns null for foreign/legacy order ids', () => {
    expect(parseSolidgateOrderId('spike_9289d948')).toBeNull();
    expect(parseSolidgateOrderId('a:b')).toBeNull();
    expect(parseSolidgateOrderId('a:b:zero')).toBeNull();
    expect(parseSolidgateOrderId('a:b:1:extra')).toBeNull();
  });
});
