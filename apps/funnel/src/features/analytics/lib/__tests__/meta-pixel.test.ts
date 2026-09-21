import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installLoadedPixel() {
  const fbq = vi.fn() as ReturnType<typeof vi.fn> & { callMethod?: ReturnType<typeof vi.fn> };
  fbq.callMethod = vi.fn();
  (window as unknown as { fbq: typeof fbq }).fbq = fbq;
  return fbq;
}

describe('Meta Pixel advanced matching', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_META_PIXEL_ID = 'pixel-test';
    delete (window as unknown as { fbq?: unknown }).fbq;
  });

  afterEach(() => {
    delete (window as unknown as { fbq?: unknown }).fbq;
  });

  it('retains hashed email when capture happens before fbevents.js loads', async () => {
    const { initMetaPixel, setMetaUserData } = await import('../meta-pixel');
    const hashedEmail = 'a'.repeat(64);
    setMetaUserData(hashedEmail);
    const fbq = installLoadedPixel();

    initMetaPixel();

    expect(fbq).toHaveBeenNthCalledWith(1, 'init', 'pixel-test', { em: hashedEmail });
    expect(fbq).toHaveBeenNthCalledWith(2, 'track', 'PageView');
  });

  it('re-initializes a loaded Pixel with a valid normalized email hash', async () => {
    const { setMetaUserData } = await import('../meta-pixel');
    const fbq = installLoadedPixel();
    const hashedEmail = 'B'.repeat(64);

    setMetaUserData(hashedEmail);

    expect(fbq).toHaveBeenCalledWith('init', 'pixel-test', {
      em: hashedEmail.toLowerCase(),
    });
  });

  it('rejects malformed advanced-matching values', async () => {
    const { setMetaUserData } = await import('../meta-pixel');
    const fbq = installLoadedPixel();

    setMetaUserData('raw-email@example.com');

    expect(fbq).not.toHaveBeenCalled();
  });
});
