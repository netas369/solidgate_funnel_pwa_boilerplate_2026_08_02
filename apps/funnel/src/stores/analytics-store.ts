'use client';

import { create } from 'zustand';

export interface AnalyticsEvent {
  type: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface AnalyticsState {
  events: AnalyticsEvent[];
  trackEvent: (type: string, metadata?: Record<string, unknown>) => void;
  getEventsByType: (type: string) => AnalyticsEvent[];
  clearEvents: () => void;
}

export const useAnalyticsStore = create<AnalyticsState>()((set, get) => ({
  events: [],
  trackEvent: (type, metadata) =>
    set((state) => ({
      events: [
        ...state.events,
        {
          type,
          timestamp: Date.now(),
          metadata,
        },
      ],
    })),
  getEventsByType: (type) =>
    get().events.filter((event) => event.type === type),
  clearEvents: () => set({ events: [] }),
}));
