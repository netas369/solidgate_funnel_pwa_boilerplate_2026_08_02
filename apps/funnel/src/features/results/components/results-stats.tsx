'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';

interface StatItem {
  value: string;
  label: string;
}

interface ResultsStatsProps {
  stats: StatItem[];
}

export function ResultsStats({ stats }: ResultsStatsProps) {
  const t = useTranslations('common.results');
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
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      <p className="text-xs font-bold uppercase tracking-widest text-si-on-surface-variant">
        {t('statsEyebrow')}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {stats.map((stat, index) => (
          <div key={index} className="rounded-2xl bg-si-primary/5 p-4 text-center">
            <p className="font-heading text-3xl font-bold text-si-on-surface">{stat.value}</p>
            <p className="mt-1 text-xs leading-snug text-si-on-surface-variant">{stat.label}</p>
          </div>
        ))}
      </div>
    </motion.section>
  );
}
