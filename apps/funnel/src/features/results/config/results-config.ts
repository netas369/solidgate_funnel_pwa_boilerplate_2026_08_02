/**
 * Segment-specific results copy — an OPT-IN scaffold.
 *
 * There is no /results route in `app/[locale]` today: `ResultsPage` is wired to
 * nothing, so this file changes no live behaviour. Keep it as the pattern for a
 * quiz-answer-driven results page, or delete `features/results/` outright — but
 * do not ship it unreachable and half-edited.
 *
 * TODO(new product): `SegmentKey` MUST stay in lockstep with the option ids of
 * the quiz's `primaryGoal` question. `ResultsPage` early-returns null for an
 * answer with no matching key, so a rename here silently blanks the page.
 * `results-config.test.ts` pins the current four keys.
 */
export type SegmentKey = 'self-esteem' | 'health' | 'event' | 'emotional_eating';

export interface Testimonial {
  name: string;
  quote: string;
  avatar?: string;
}

export interface SegmentConfig {
  heroHeadline: string;
  heroSubheadline: string;
  programName: string;
  benefits: string[];
  testimonials: Testimonial[];
}

export const SEGMENT_CONFIGS: Record<SegmentKey, SegmentConfig> = {
  'self-esteem': {
    heroHeadline: 'Your Confidence-Focused Starter Path Is Ready',
    heroSubheadline:
      'Use this sample segment to test a confidence-led outcome and route users into the right offer.',
    programName: 'Confidence Funnel Template',
    benefits: [
      'Shows how to tailor headline copy from quiz answers',
      'Gives you a placeholder benefit stack to customize',
      'Keeps the results-to-offer transition intact',
      'Works as a ready-made sample while you replace content',
    ],
    testimonials: [
      {
        name: 'Starter User A',
        quote:
          'We swapped in our own copy pack and had a new results page running without touching the checkout flow.',
      },
      {
        name: 'Starter User B',
        quote:
          'This starter made it much easier to validate new funnel ideas because the plumbing was already there.',
      },
    ],
  },
  health: {
    heroHeadline: 'Your Performance-Focused Starter Path Is Ready',
    heroSubheadline:
      'Use this sample segment for a wellbeing or performance-oriented offer path.',
    programName: 'Performance Funnel Template',
    benefits: [
      'Demonstrates segment-specific messaging',
      'Keeps the same navigation and analytics flow',
      'Lets you test multi-offer positioning quickly',
      'Acts as a safe placeholder until your real content is ready',
    ],
    testimonials: [
      {
        name: 'Starter User C',
        quote:
          'We reused the offer and PWA access layers, then only replaced the segment copy and assets.',
      },
      {
        name: 'Starter User D',
        quote:
          'It feels much more like a platform now than a one-off app, which is exactly what we needed.',
      },
    ],
  },
  event: {
    heroHeadline: 'Your Campaign-Specific Starter Path Is Ready',
    heroSubheadline:
      'Use this sample path for launches, challenges, time-boxed programmes, or deadline-driven funnels.',
    programName: 'Campaign Funnel Template',
    benefits: [
      'Represents a limited-time or event-based segment',
      'Provides starter messaging for urgency-driven offers',
      'Preserves the same downstream checkout wiring',
      'Helps you validate new positioning before polishing copy',
    ],
    testimonials: [
      {
        name: 'Starter User E',
        quote:
          'We launched a niche campaign using the existing results and payment flow in a fraction of the usual time.',
      },
      {
        name: 'Starter User F',
        quote:
          'Having the platform prebuilt meant we could focus on copy, creative, and pricing instead of infrastructure.',
      },
    ],
  },
  emotional_eating: {
    heroHeadline: 'Your Habit-Change Starter Path Is Ready',
    heroSubheadline:
      'Use this sample path when you want a behaviour-change or support-led offer angle.',
    programName: 'Habit Change Funnel Template',
    benefits: [
      'Shows how to frame a support-oriented result page',
      'Keeps the same event tracking and persistence hooks',
      'Lets you plug in your own testimonials later',
      'Provides a neutral baseline instead of brand-locked content',
    ],
    testimonials: [
      {
        name: 'Starter User G',
        quote:
          'This gave us a working flow immediately, then we iterated the messaging once the funnel logic was proven.',
      },
      {
        name: 'Starter User H',
        quote:
          'The starter copy is neutral enough that any niche can take it over without fighting the original brand.',
      },
    ],
  },
};

export const GENERIC_STATS = [
  { value: 'Quiz', label: 'result segmentation ready' },
  { value: 'Secure', label: 'checkout stack retained' },
  { value: 'PWA', label: 'member area included' },
];
