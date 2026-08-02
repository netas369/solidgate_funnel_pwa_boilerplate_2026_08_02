'use client';

import { create } from 'zustand';
import { type FunnelStage, FUNNEL_STAGE_ORDER } from '@/features/quiz/types';

interface FunnelState {
  currentStage: FunnelStage;
  setStage: (stage: FunnelStage) => void;
  canAdvanceTo: (stage: FunnelStage) => boolean;
}

export const useFunnelStore = create<FunnelState>()((set, get) => ({
  currentStage: 'landing',
  setStage: (stage) => set({ currentStage: stage }),
  canAdvanceTo: (stage) => {
    const currentIndex = FUNNEL_STAGE_ORDER.indexOf(get().currentStage);
    const targetIndex = FUNNEL_STAGE_ORDER.indexOf(stage);
    return targetIndex === currentIndex + 1;
  },
}));
