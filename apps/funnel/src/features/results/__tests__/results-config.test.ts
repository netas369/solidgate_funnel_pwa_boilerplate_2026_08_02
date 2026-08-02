import { describe, it, expect } from 'vitest';
import { SEGMENT_CONFIGS, GENERIC_STATS } from '../config/results-config';
import type { SegmentKey } from '../config/results-config';

const EXPECTED_KEYS: SegmentKey[] = ['self-esteem', 'health', 'event', 'emotional_eating'];

describe('SEGMENT_CONFIGS', () => {
  it('has exactly 4 keys matching all primaryGoal values', () => {
    const keys = Object.keys(SEGMENT_CONFIGS);
    expect(keys).toHaveLength(4);
    expect(keys.sort()).toEqual(EXPECTED_KEYS.slice().sort());
  });

  EXPECTED_KEYS.forEach((key) => {
    describe(`segment: ${key}`, () => {
      it('has non-empty heroHeadline', () => {
        expect(SEGMENT_CONFIGS[key].heroHeadline.length).toBeGreaterThan(0);
      });

      it('has non-empty heroSubheadline', () => {
        expect(SEGMENT_CONFIGS[key].heroSubheadline.length).toBeGreaterThan(0);
      });

      it('has non-empty programName', () => {
        expect(SEGMENT_CONFIGS[key].programName.length).toBeGreaterThan(0);
      });

      it('has benefits array with 3-5 items, all non-empty strings', () => {
        const { benefits } = SEGMENT_CONFIGS[key];
        expect(benefits.length).toBeGreaterThanOrEqual(3);
        expect(benefits.length).toBeLessThanOrEqual(5);
        benefits.forEach((b) => {
          expect(typeof b).toBe('string');
          expect(b.length).toBeGreaterThan(0);
        });
      });

      it('has testimonials array with 2-3 items, each with non-empty name and quote', () => {
        const { testimonials } = SEGMENT_CONFIGS[key];
        expect(testimonials.length).toBeGreaterThanOrEqual(2);
        expect(testimonials.length).toBeLessThanOrEqual(3);
        testimonials.forEach((t) => {
          expect(typeof t.name).toBe('string');
          expect(t.name.length).toBeGreaterThan(0);
          expect(typeof t.quote).toBe('string');
          expect(t.quote.length).toBeGreaterThan(0);
        });
      });
    });
  });
});

describe('GENERIC_STATS', () => {
  it('has exactly 3 items', () => {
    expect(GENERIC_STATS).toHaveLength(3);
  });

  it('each item has non-empty value and label', () => {
    GENERIC_STATS.forEach((stat) => {
      expect(typeof stat.value).toBe('string');
      expect(stat.value.length).toBeGreaterThan(0);
      expect(typeof stat.label).toBe('string');
      expect(stat.label.length).toBeGreaterThan(0);
    });
  });
});
