'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { SegmentConfig } from '../config/results-config';

interface ResultsHeroProps {
  segment: SegmentConfig;
}

export function ResultsHero({ segment }: ResultsHeroProps) {
  const shouldReduceMotion = useReducedMotion();

  const variants = {
    hidden: { opacity: 0, y: shouldReduceMotion ? 0 : 24 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <motion.section
      variants={variants}
      initial="hidden"
      animate="visible"
      transition={{ duration: 0.4 }}
    >
      <span className="inline-block rounded-full bg-si-secondary-container/20 border border-si-outline-variant/30 px-3 py-1 text-xs font-bold uppercase tracking-widest text-si-on-secondary-container">
        {segment.programName}
      </span>
      <h1 className="mt-4 font-heading text-3xl font-bold leading-tight tracking-tight text-[#1E2A5E] md:text-4xl">
        {segment.heroHeadline}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-si-on-surface-variant">
        {segment.heroSubheadline}
      </p>
    </motion.section>
  );
}
