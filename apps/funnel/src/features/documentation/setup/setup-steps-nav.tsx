'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { setupStepsNavigation } from '../setup-navigation';

type StepId = typeof setupStepsNavigation[number]['id'];

export function SetupStepsNav({ current }: { current: StepId }) {
  return (
    <nav className="setup-steps-navigation" aria-label="Penki mokėjimų integracijos žingsniai">
      <Tabs value={current}>
        <TabsList className="setup-steps-list" aria-label="Pasirink instrukcijų žingsnį">
          {setupStepsNavigation.map((step) => (
            <TabsTrigger key={step.id} value={step.id} nativeButton={false} render={<Link href={step.href} />} aria-current={current === step.id ? 'page' : undefined} className="setup-step-link">
              <span className="font-mono text-xs">{step.id}</span><span>{step.shortTitle}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <p>Vykdyk eilės tvarka. Kito žingsnio promptui perduok ankstesnio žingsnio rezultatą ir patikrų įrodymus.</p>
    </nav>
  );
}

export function SetupStepPagination({ current }: { current: StepId }) {
  const index = setupStepsNavigation.findIndex((step) => step.id === current);
  const previous = setupStepsNavigation[index - 1];
  const next = setupStepsNavigation[index + 1];
  return (
    <nav className="setup-step-pagination" aria-label="Ankstesnis ir kitas integracijos žingsnis">
      {previous ? <Button variant="outline" nativeButton={false} render={<Link href={previous.href} />}><ArrowLeft />{previous.id}. {previous.title}</Button> : <span />}
      {next ? <Button nativeButton={false} render={<Link href={next.href} />}>{next.id}. {next.title}<ArrowRight /></Button> : <Button variant="outline" nativeButton={false} render={<Link href="/documentation" />}>Grįžti į dokumentaciją<ArrowRight /></Button>}
    </nav>
  );
}
