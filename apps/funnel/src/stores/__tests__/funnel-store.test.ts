import { describe, it, expect, beforeEach } from 'vitest';
import { useFunnelStore } from '@/stores/funnel-store';

describe('useFunnelStore', () => {
  beforeEach(() => {
    useFunnelStore.setState({
      currentStage: 'landing',
    });
  });

  it('has initial stage of landing', () => {
    expect(useFunnelStore.getState().currentStage).toBe('landing');
  });

  it('setStage updates currentStage', () => {
    useFunnelStore.getState().setStage('quiz');
    expect(useFunnelStore.getState().currentStage).toBe('quiz');
  });

  it('supports full stage cycle progression', () => {
    const stages = [
      'landing',
      'quiz',
      'lead_capture',
      'results',
      'offer',
      'checkout',
      'success',
    ] as const;

    for (const stage of stages) {
      useFunnelStore.getState().setStage(stage);
      expect(useFunnelStore.getState().currentStage).toBe(stage);
    }
  });

  it('canAdvanceTo returns true for the next stage', () => {
    useFunnelStore.setState({ currentStage: 'landing' });
    expect(useFunnelStore.getState().canAdvanceTo('quiz')).toBe(true);
  });

  it('canAdvanceTo returns false for non-adjacent future stage', () => {
    useFunnelStore.setState({ currentStage: 'landing' });
    expect(useFunnelStore.getState().canAdvanceTo('results')).toBe(false);
  });
});
