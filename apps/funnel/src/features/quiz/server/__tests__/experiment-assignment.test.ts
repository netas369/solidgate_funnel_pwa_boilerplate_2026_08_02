import { describe, expect, it } from 'vitest';
import { FUNNEL_VARIANT } from '../quiz-definition';
import { assignFunnelVariant, parseFunnelVariantWeights } from '../experiment-assignment';

describe('funnel experiment assignment', () => {
  it('uses the boilerplate default when weights are absent or invalid', () => {
    expect(assignFunnelVariant('visitor-1', undefined)).toBe(FUNNEL_VARIANT);
    expect(assignFunnelVariant('visitor-1', 'control:0,test:100')).toBe(FUNNEL_VARIANT);
    expect(assignFunnelVariant('visitor-1', 'control:50,control:50')).toBe(FUNNEL_VARIANT);
  });

  it('parses an explicit weighted variant list', () => {
    expect(parseFunnelVariantWeights('control-v1:70,treatment-v1:30')).toEqual([
      { name: 'control-v1', weight: 70 },
      { name: 'treatment-v1', weight: 30 },
    ]);
  });

  it('returns the same assignment for the same visitor and experiment', () => {
    const first = assignFunnelVariant('visitor-123', 'control:50,treatment:50', 'hero-test');
    expect(assignFunnelVariant('visitor-123', 'control:50,treatment:50', 'hero-test')).toBe(first);
    expect(['control', 'treatment']).toContain(first);
  });

  it('can allocate traffic to every configured variant', () => {
    const assignments = new Set(
      Array.from({ length: 100 }, (_, index) =>
        assignFunnelVariant(`visitor-${index}`, 'control:50,treatment:50', 'hero-test'),
      ),
    );
    expect(assignments).toEqual(new Set(['control', 'treatment']));
  });
});
