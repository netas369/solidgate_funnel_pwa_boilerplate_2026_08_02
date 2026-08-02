export type FunnelStage =
  | 'landing'
  | 'quiz'
  | 'lead_capture'
  | 'results'
  | 'offer'
  | 'checkout'
  | 'success';

export const FUNNEL_STAGE_ORDER: FunnelStage[] = [
  'landing',
  'quiz',
  'lead_capture',
  'results',
  'offer',
  'checkout',
  'success',
];
