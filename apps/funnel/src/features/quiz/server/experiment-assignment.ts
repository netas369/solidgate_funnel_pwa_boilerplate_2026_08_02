import { createHash } from 'node:crypto';
import { FUNNEL_VARIANT } from './quiz-definition';

const VARIANT_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_VARIANTS = 20;

type WeightedVariant = { name: string; weight: number };

export function parseFunnelVariantWeights(value: string | undefined): WeightedVariant[] | null {
  if (!value) return null;
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_VARIANTS) return null;

  const variants: WeightedVariant[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const separator = entry.lastIndexOf(':');
    const name = entry.slice(0, separator);
    const rawWeight = entry.slice(separator + 1);
    const weight = Number(rawWeight);
    if (
      separator <= 0 ||
      !VARIANT_NAME.test(name) ||
      !Number.isInteger(weight) ||
      weight < 1 ||
      weight > 10_000 ||
      names.has(name)
    ) {
      return null;
    }
    names.add(name);
    variants.push({ name, weight });
  }
  return variants;
}

/** Stable, server-owned weighted assignment for funnel presentation tests. */
export function assignFunnelVariant(
  visitorId: string,
  weights = process.env.FUNNEL_VARIANT_WEIGHTS,
  experimentKey = process.env.FUNNEL_EXPERIMENT_KEY ?? 'funnel-v1',
): string {
  const variants = parseFunnelVariantWeights(weights);
  if (!variants) return FUNNEL_VARIANT;

  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const bucket = Number.parseInt(
    createHash('sha256').update(`${experimentKey}:${visitorId}`).digest('hex').slice(0, 12),
    16,
  ) % total;

  let boundary = 0;
  for (const variant of variants) {
    boundary += variant.weight;
    if (bucket < boundary) return variant.name;
  }
  return FUNNEL_VARIANT;
}
