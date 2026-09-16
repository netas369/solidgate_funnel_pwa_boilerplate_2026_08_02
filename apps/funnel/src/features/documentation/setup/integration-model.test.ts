import { describe, expect, it } from 'vitest';
import { integrationSteps } from './integration-steps';
import { INTEGRATION_ARTIFACTS, PROVIDER_MANIFEST_PATH, buildIntegrationPrompt, createInitialIntegrationContext, isIntegrationContext, validateIntegrationContext, type IntegrationContext } from './integration-model';

function validContext(): IntegrationContext {
  const context = createInitialIntegrationContext();
  return { ...context, appKey: 'myapp', channelReference: 'sandbox-test-channel', catalogVersion: 'catalog-260510', offers: context.offers.map((offer) => ({ ...offer, pricingReference: offer.pricingReference || 'packages/shared/src/price-map.ts' })) };
}
function dataFor(stepId: string, context = validContext()) {
  const step = integrationSteps.find((item) => item.id === stepId)!;
  const prompt = buildIntegrationPrompt(step, context);
  return JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)![1]);
}

describe('complete main and OTO plan', () => {
  it('does not enable copying with unknown one-time prices or channel', () => {
    const config = createInitialIntegrationContext();
    expect(isIntegrationContext(config)).toBe(true);
    expect(validateIntegrationContext(config).valid).toBe(false);
    expect(() => buildIntegrationPrompt(integrationSteps[0], config)).toThrow();
  });
  it('accepts a main subscription and exactly one separate subscription OTO', () => {
    expect(validateIntegrationContext(validContext())).toEqual({ valid: true, issues: [] });
  });
  it.each([1, 3, 7])('rejects adding a second subscription at OTO%i', (step) => {
    const config = validContext();
    config.offers.find((offer) => offer.step === step)!.billingType = 'subscription';
    expect(validateIntegrationContext(config).valid).toBe(false);
  });
  it('rejects moving subscription type away from the SQL-bound OTO2 slot', () => {
    const config = validContext();
    config.offers.find((offer) => offer.step === 2)!.billingType = 'one_time';
    config.offers.find((offer) => offer.step === 3)!.billingType = 'subscription';
    expect(validateIntegrationContext(config).valid).toBe(false);
  });
  it('keeps main trial eligibility together and add-on eligibility separate', () => {
    const config = validContext();
    config.offers.push({ ...config.offers[0], id: 'main-trial2', offerKey: 'trial2' });
    expect(validateIntegrationContext(config).valid).toBe(true);
    config.offers.find((offer) => offer.step === 2)!.entitlementKey = 'main';
    expect(validateIntegrationContext(config).valid).toBe(false);
  });
  it('never enables main cancellation by default; allows explicit OTO1 lifetime only', () => {
    const config = validContext();
    expect(config.offers.every((offer) => offer.afterPurchase === 'grant_only')).toBe(true);
    config.offers.find((offer) => offer.step === 1)!.afterPurchase = 'cancel_main_after_capture';
    expect(validateIntegrationContext(config).valid).toBe(true);
    config.offers.find((offer) => offer.step === 2)!.afterPurchase = 'cancel_main_after_capture';
    expect(validateIntegrationContext(config).valid).toBe(false);
  });
  it('supports OTO3 alternative options without inventing another payable step', () => {
    const config = validContext();
    const bundle = config.offers.find((offer) => offer.step === 3)!;
    config.offers.push({ ...bundle, id: 'oto3-option-b', offerKey: 'oto3_option_b', entitlementKey: 'bundle_b' });
    expect(validateIntegrationContext(config).valid).toBe(true);
    config.offers.push({ ...config.offers[1], id: 'oto1-b', offerKey: 'oto1_option_b' });
    expect(validateIntegrationContext(config).valid).toBe(false);
  });
  it('rejects missing steps, duplicate slugs and summary purchases', () => {
    const missing = validContext(); missing.offers = missing.offers.filter((offer) => offer.step !== 4);
    expect(validateIntegrationContext(missing).valid).toBe(false);
    const duplicate = validContext(); duplicate.offers[1].offerKey = duplicate.offers[0].offerKey;
    expect(validateIntegrationContext(duplicate).valid).toBe(false);
    const summary = validContext(); summary.offers.push({ ...summary.offers[1], id: 'oto8', step: 8, offerKey: 'oto8_summary' });
    expect(validateIntegrationContext(summary).valid).toBe(false);
  });
  it('rejects malformed stored data without losing support for incomplete drafts', () => {
    expect(isIntegrationContext({})).toBe(false);
    expect(isIntegrationContext({ ...validContext(), environment: 'unknown' })).toBe(false);
    expect(isIntegrationContext({ ...validContext(), offers: [null] })).toBe(false);
    expect(isIntegrationContext({ ...validContext(), offers: [{ ...validContext().offers[0], step: '2' }] })).toBe(false);
    expect(isIntegrationContext(createInitialIntegrationContext())).toBe(true);
  });
  it.each(['https://example.com/prices.json', '../outside.json', '/tmp/manifest.json'])('keeps artifact references in the target repo: %s', (providerManifestPath) => {
    expect(validateIntegrationContext({ ...validContext(), providerManifestPath }).valid).toBe(false);
  });
});

describe('step artifact handoffs', () => {
  it('each later step requires the preceding reports and shared contract', () => {
    expect(dataFor('02').required_input_artifacts).toEqual([PROVIDER_MANIFEST_PATH]);
    for (const step of integrationSteps.slice(1)) {
      const data = dataFor(step.id);
      expect(data.billing_descriptor_policy).toBe('static_channel_connector_only');
      expect(data.required_input_artifacts).toContain('docs/payments/setup/02-commerce-contract.json');
      expect(data.required_input_artifacts).toContain('docs/payments/setup/02-catalog-report.md');
      const predecessor = String(Number(step.id) - 1).padStart(2, '0') as keyof typeof INTEGRATION_ARTIFACTS;
      for (const artifact of INTEGRATION_ARTIFACTS[predecessor]) expect(data.required_input_artifacts).toContain(artifact);
      expect(data.output_artifacts.some((artifact: string) => data.required_input_artifacts.includes(artifact))).toBe(false);
    }
  });
  it('custom first manifest references propagate through every step', () => {
    const context = { ...validContext(), providerManifestPath: 'docs/payments/sandbox/provider.json' };
    for (const step of integrationSteps) {
      const data = dataFor(step.id, context);
      expect(data.required_input_artifacts).toContain(context.providerManifestPath);
      expect(data.required_input_artifacts).not.toContain(PROVIDER_MANIFEST_PATH);
      expect(data.offers.filter((offer: { billing_type: string }) => offer.billing_type === 'subscription').every((offer: { pricing_reference: string }) => offer.pricing_reference === context.providerManifestPath)).toBe(true);
    }
  });
  it('preserves checkout slugs without pretending to create provider IDs', () => {
    const data = dataFor('02');
    expect(data.billing_descriptor_policy).toBe('static_channel_connector_only');
    expect(data.catalog_version).toBe('catalog-260510');
    const addon = data.offers.find((offer: { oto_step: number }) => offer.oto_step === 2);
    expect(addon.runtime_product_slug).toBe('oto2_addon_weekly');
    expect(addon.billing_type).toBe('subscription');
    expect(addon.entitlement_key).toBe('addon');
    expect(addon).not.toHaveProperty('product_id');
    expect(data.offers.filter((offer: { placement: string; billing_type: string }) => offer.placement === 'oto' && offer.billing_type === 'subscription')).toHaveLength(1);
  });
});
