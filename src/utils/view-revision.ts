import type { Env } from '../types';

export function viewRevision(env: Pick<Env, 'CF_VERSION_METADATA' | 'VIEW_REVISION'>): string {
  const value = env.CF_VERSION_METADATA?.id
    || env.CF_VERSION_METADATA?.tag
    || env.CF_VERSION_METADATA?.timestamp
    || env.VIEW_REVISION
    || 'dev';
  return String(value).replace(/[^A-Za-z0-9._:-]/g, '-');
}
