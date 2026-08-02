'use client';

import { CheckCircle2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

interface ResultsBenefitsProps {
  benefits: string[];
}

export function ResultsBenefits({ benefits }: ResultsBenefitsProps) {
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
      transition={{ duration: 0.4, delay: 0.1 }}
    >
      <p className="text-xs font-bold uppercase tracking-widest text-si-on-surface-variant">
        Your Personalised Programme Includes
      </p>
      <div className="mt-4 rounded-2xl bg-white p-5 shadow-md ring-1 ring-black/5">
        <div className="space-y-3">
          {benefits.map((benefit, index) => (
            <div key={index} className="flex items-start gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-si-secondary/10">
                <CheckCircle2 className="h-4 w-4 text-si-secondary" />
              </div>
              <p className="text-sm leading-relaxed text-si-on-surface-variant">{benefit}</p>
            </div>
          ))}
        </div>
      </div>
    </motion.section>
  );
}
