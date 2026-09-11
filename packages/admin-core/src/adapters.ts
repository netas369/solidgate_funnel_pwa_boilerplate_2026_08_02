import type { AdminProjectConfig, AdminSupportActionKey } from './config';
import type { AdminDataResult } from './result';

export interface AdminDateRange {
  from: string;
  to: string;
}

export interface AdminAnalyticsAdapter<TSnapshot = unknown> {
  id: string;
  readSnapshot(range: AdminDateRange, config: AdminProjectConfig): Promise<AdminDataResult<TSnapshot>>;
  checkHealth?(): Promise<AdminDataResult<{ healthy: boolean; detail?: string }>>;
}

export interface AdminSupportAdapter<TReport = unknown> {
  id: string;
  lookupExactEmail(email: string, config: AdminProjectConfig): Promise<TReport>;
  checkHealth?(): Promise<AdminDataResult<{ healthy: boolean; detail?: string }>>;
}

export interface AdminSupportActionContext {
  actorUserId: string;
  customerUserId: string;
  customerEmail: string;
  idempotencyKey: string;
}

export interface AdminSupportActionDefinition<TResult = unknown> {
  id: AdminSupportActionKey;
  label: string;
  risk: 'low' | 'medium' | 'high';
  execute(context: AdminSupportActionContext): Promise<TResult>;
}
