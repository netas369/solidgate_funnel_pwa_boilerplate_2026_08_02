export type AdminDataStatus = 'ready' | 'partial' | 'unavailable';

export interface AdminDataWarning {
  code: string;
  message: string;
  source?: string;
}

export interface AdminDataResult<T> {
  data: T;
  status: AdminDataStatus;
  warnings: readonly AdminDataWarning[];
  source: string;
  calculatedAt: string;
  dataThrough: string | null;
}

interface ResultOptions {
  source: string;
  calculatedAt?: string;
  dataThrough?: string | null;
}

export function readyAdminData<T>(data: T, options: ResultOptions): AdminDataResult<T> {
  return {
    data,
    status: 'ready',
    warnings: [],
    source: options.source,
    calculatedAt: options.calculatedAt ?? new Date().toISOString(),
    dataThrough: options.dataThrough ?? null,
  };
}

export function partialAdminData<T>(
  data: T,
  warnings: readonly AdminDataWarning[],
  options: ResultOptions,
): AdminDataResult<T> {
  return {
    ...readyAdminData(data, options),
    status: 'partial',
    warnings,
  };
}

export function unavailableAdminData<T>(
  fallback: T,
  warning: AdminDataWarning,
  options: ResultOptions,
): AdminDataResult<T> {
  return {
    ...readyAdminData(fallback, options),
    status: 'unavailable',
    warnings: [warning],
  };
}
