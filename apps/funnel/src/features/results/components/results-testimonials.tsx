'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { Testimonial } from '../config/results-config';

interface ResultsTestimonialsProps {
  testimonials: Testimonial[];
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

function TestimonialAvatar({ name, avatar }: { name: string; avatar?: string }) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        className="h-10 w-10 rounded-full object-cover"
      />
    );
  }

  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-si-primary-container text-sm font-bold text-si-on-primary">
      {getInitials(name)}
    </div>
  );
}

export function ResultsTestimonials({ testimonials }: ResultsTestimonialsProps) {
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
      transition={{ duration: 0.4, delay: 0.3 }}
    >
      <p className="text-xs font-bold uppercase tracking-widest text-si-on-surface-variant">
        What Others Are Saying
      </p>
      <div className="mt-4 space-y-3">
        {testimonials.map((testimonial, index) => (
          <div key={index} className="rounded-2xl bg-white p-5 shadow-md ring-1 ring-black/5">
            <div className="flex items-start gap-3">
              <TestimonialAvatar name={testimonial.name} avatar={testimonial.avatar} />
              <div className="flex-1">
                <p className="text-sm font-bold text-si-on-surface">{testimonial.name}</p>
                <p className="mt-1 text-sm leading-relaxed text-si-on-surface-variant">
                  &ldquo;{testimonial.quote}&rdquo;
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </motion.section>
  );
}
