import { PLUGIN_ORIGIN, pluginById } from '../plugins/registry';
import type { Env } from '../types';
import { claimAdminJob, completeAdminJob, failAdminJob } from './admin-jobs';

export async function runCmsAdminJob(env: Env, jobId: string): Promise<void> {
  const job = await claimAdminJob(env.DB, jobId);
  if (!job) return;

  try {
    if (job.type !== 'plugin_admin_action') throw new Error(`Unsupported admin job type ${job.type}`);
    if (!job.pluginId || !job.method || !job.path || !job.user) throw new Error('Admin job is missing plugin request data');

    const plugin = await pluginById(env, job.pluginId);
    if (!plugin) throw new Error(`Plugin ${job.pluginId} is not available`);
    if (!plugin.secret) throw new Error(`Plugin ${job.pluginId} has no secret configured`);

    const headers = new Headers();
    headers.set('x-cms-user', JSON.stringify({
      id: job.user.sub,
      email: job.user.email,
      name: job.user.name,
      role: job.user.role,
    }));
    headers.set('x-plugin-secret', plugin.secret);
    headers.set('x-cms-background-job', '1');
    if (job.contentType) headers.set('content-type', job.contentType);

    const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${job.path}`, {
      method: job.method,
      headers,
      body: job.method === 'GET' || job.method === 'HEAD' ? undefined : job.body ?? undefined,
      redirect: 'manual',
    });

    if (response.status < 200 || response.status >= 400) {
      const text = await response.text().catch(() => '');
      throw new Error(`Plugin action returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }

    await completeAdminJob(env.DB, job.id, response.status, response.headers.get('location'));
  } catch (error) {
    await failAdminJob(env.DB, job.id, error);
    console.error(`[cms] admin job ${job.id} failed`, error);
  }
}
