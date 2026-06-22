// ============================================================
// Lifecycle hook dispatch — fans a CMS event out to every plugin
// that subscribed to it in its manifest.
//
// Hooks are best-effort: delivered via executionCtx.waitUntil so
// they never block the editor response, and failures are logged
// rather than surfaced to the user.
// ============================================================

import type { AppContext } from '../utils/context';
import type { Env, JWTPayload } from '../types';
import { pluginsForHook, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';
import { logAudit } from '../utils/audit';

/** A minimal page snapshot delivered to plugins. Plugins receive whatever the
 *  triggering handler has on hand — `id` is always present. */
export interface HookPage {
  id: number;
  uuid?: string;
  page_type?: string | null;
  name?: string;
  slug?: string;
}

/** Lifecycle events the CMS emits. */
export type HookEvent = 'create' | 'update' | 'publish' | 'unpublish' | 'delete';

/**
 * Fire-and-forget hook dispatch. Safe to call from any admin handler; it never
 * throws and never blocks the response.
 */
export function dispatchHook(c: AppContext, event: HookEvent, page: HookPage): void {
  // Every page lifecycle event flows through here — the natural choke point
  // for the audit trail.
  logAudit(c, `page.${event}`, 'page', page.id, {
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  const promise = deliverHook(c.env, c.get('user'), event, page);
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let the promise run detached.
    void promise.catch(() => {});
  }
}

/**
 * Awaitable core: POSTs the event to each subscribed plugin. Exported so tests
 * can await delivery deterministically.
 */
export async function deliverHook(
  env: Env,
  user: JWTPayload | undefined,
  event: HookEvent,
  page: HookPage,
): Promise<void> {
  const plugins = await pluginsForHook(env, event);
  if (plugins.length === 0) return;

  const body = JSON.stringify({
    event,
    page,
    user: user
      ? { id: user.sub, email: user.email, name: user.name, role: user.role }
      : null,
  });

  await Promise.all(
    plugins.map(async (plugin) => {
      if (!plugin.secret) {
        console.error(`Plugin ${plugin.binding} has no secret configured; skipping hook ${event}`);
        return;
      }
      try {
        const response = await plugin.fetcher.fetch(
          `${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/hooks/${event}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-plugin-secret': plugin.secret,
            },
            body,
          },
        );
        if (!response.ok) {
          console.error(`Plugin ${plugin.binding} hook ${event} returned ${response.status}`);
        }
      } catch (error) {
        console.error(`Plugin ${plugin.binding} hook ${event} failed:`, error);
      }
    }),
  );
}
