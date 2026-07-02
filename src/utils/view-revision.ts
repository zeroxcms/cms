import type { Env, PluginManifest } from '../types';

export function viewRevision(env: Pick<Env, 'CF_VERSION_METADATA' | 'VIEW_REVISION'>): string {
  const value = env.CF_VERSION_METADATA?.id
    || env.CF_VERSION_METADATA?.tag
    || env.CF_VERSION_METADATA?.timestamp
    || env.VIEW_REVISION
    || 'dev';
  return cleanRevision(value);
}

export function pluginWorkerRevision(manifest: PluginManifest): string {
  const workerVersion = manifest.workerVersion;
  const metadata = typeof workerVersion === 'object' && workerVersion !== null
    ? workerVersion
    : manifest.cfVersionMetadata || manifest.CF_VERSION_METADATA;
  return cleanRevision(
    manifest.workerVersionId
      || manifest.worker_version_id
      || (typeof workerVersion === 'string' ? workerVersion : '')
      || metadata?.id
      || metadata?.tag
      || metadata?.timestamp
      || '',
  );
}

export function pluginViewRevision(manifest: PluginManifest): string {
  return pluginWorkerRevision(manifest) || cleanRevision(manifest.version);
}

function cleanRevision(value: unknown): string {
  return String(value || '').replace(/[^A-Za-z0-9._:-]/g, '-');
}
