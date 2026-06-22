import { adminLayout, escHtml, type BaseTemplateProps } from './layout';

export interface PluginListItem {
  id: number;
  label: string;
  url: string;
  enabled: boolean;
  /** Resolved from the live manifest, when the plugin is reachable. */
  status: 'active' | 'unreachable' | 'disabled';
  manifestId?: string;
  manifestName?: string;
  version?: string;
}

const STATUS_BADGE: Record<PluginListItem['status'], string> = {
  active: 'bg-green-100 text-green-800',
  unreachable: 'bg-red-100 text-red-800',
  disabled: 'bg-gray-100 text-gray-600',
};

export async function pluginsManagePage(views: Fetcher, opts: BaseTemplateProps & {
  plugins: PluginListItem[];
}): Promise<string> {
  const { plugins } = opts;
  const rows = plugins.length === 0
    ? `<tr><td colspan="4" class="px-4 py-8 text-center text-sm text-gray-500">
         No plugins registered yet. <a class="text-indigo-600 font-medium" href="/admin/plugins-manage/new">Register one</a>.
       </td></tr>`
    : plugins.map((p) => {
        const title = p.manifestName || p.label || p.manifestId || p.url;
        const sub = p.manifestId ? `${escHtml(p.manifestId)}${p.version ? ` · v${escHtml(p.version)}` : ''}` : escHtml(p.url);
        return `<tr class="border-t border-gray-100">
          <td class="px-4 py-3">
            <div class="font-medium text-gray-900">${escHtml(title)}</div>
            <div class="text-xs text-gray-500">${sub}</div>
          </td>
          <td class="px-4 py-3 text-xs text-gray-500 break-all max-w-xs">${escHtml(p.url)}</td>
          <td class="px-4 py-3">
            <span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[p.status]}">${p.status}</span>
          </td>
          <td class="px-4 py-3 text-right whitespace-nowrap">
            <form method="post" action="/admin/plugins-manage/${p.id}/toggle" class="inline">
              <button class="px-3 py-1 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700">${p.enabled ? 'Disable' : 'Enable'}</button>
            </form>
            <a href="/admin/plugins-manage/${p.id}/edit" class="ml-1 px-3 py-1 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700">Edit</a>
            <form method="post" action="/admin/plugins-manage/${p.id}/delete" class="inline"
                  onsubmit="return confirm('Remove this plugin?')">
              <button class="ml-1 px-3 py-1 rounded-lg border border-red-300 text-xs font-semibold text-red-700">Delete</button>
            </form>
          </td>
        </tr>`;
      }).join('');

  const body = `<div class="max-w-5xl mx-auto px-4 py-6">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Plugins</h1>
        <p class="text-sm text-gray-500">Registered over HTTPS — added here without a CMS redeploy.</p>
      </div>
      <a href="/admin/plugins-manage/new" class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">Register plugin</a>
    </div>
    <div class="bg-white rounded-xl shadow overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr><th class="px-4 py-2">Plugin</th><th class="px-4 py-2">URL</th><th class="px-4 py-2">Status</th><th class="px-4 py-2"></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
  return adminLayout(views, opts, { title: 'Plugins', body });
}

export async function pluginFormPage(views: Fetcher, opts: BaseTemplateProps & {
  isNew: boolean;
  id?: number;
  label: string;
  url: string;
  enabled: boolean;
  sortOrder: number;
  config: string;
  secret?: string;
  flash?: string;
  error?: string;
}): Promise<string> {
  const { isNew, id, label, url, enabled, sortOrder, config, secret, flash, error } = opts;
  const heading = isNew ? 'Register Plugin' : 'Edit Plugin';
  const action = isNew ? '/admin/plugins-manage' : `/admin/plugins-manage/${id}`;
  const errorHtml = error
    ? `<div class="mb-4 px-4 py-2 rounded-lg bg-red-50 text-red-700 text-sm">${escHtml(error)}</div>`
    : '';
  const flashMessage = flash === 'secret-generated'
    ? 'Plugin registered. Copy the secret below onto the plugin Worker.'
    : flash === 'secret-rotated'
      ? 'Secret rotated. Update the plugin Worker to the new value — the old one no longer works.'
      : '';
  const flashHtml = flashMessage
    ? `<div class="mb-4 px-4 py-2 rounded-lg bg-amber-50 text-amber-800 text-sm">${escHtml(flashMessage)}</div>`
    : '';

  // Per-plugin secret panel — edit only. The secret is shown (not hashed) because
  // the CMS must transmit it to the plugin; copy it onto the plugin Worker with
  // `wrangler secret put PLUGIN_SECRET`. Rotating invalidates only this plugin.
  const secretHtml = isNew
    ? ''
    : `<div class="bg-white rounded-xl shadow p-6 mt-6">
        <h2 class="text-sm font-semibold text-gray-700 mb-1">Shared secret</h2>
        <p class="text-xs text-gray-500 mb-3">Set this exact value on the plugin Worker:
          <code>wrangler secret put PLUGIN_SECRET</code>. ${
            secret ? '' : 'This plugin has no dedicated secret yet and is using the shared <code>PLUGIN_SECRET</code> fallback — rotate to assign its own.'
          }</p>
        <input type="text" readonly value="${escHtml(secret ?? '')}" onclick="this.select()"
               class="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-gray-50 mb-3"
               placeholder="(using shared PLUGIN_SECRET fallback)">
        <form method="post" action="/admin/plugins-manage/${id}/rotate-secret"
              onsubmit="return confirm('Rotate this plugin\\'s secret? The plugin Worker must be updated to the new value or it will stop working.')">
          <button class="px-3 py-1.5 rounded-lg border border-amber-300 text-xs font-semibold text-amber-800">Rotate secret</button>
        </form>
      </div>`;

  const body = `<div class="max-w-2xl mx-auto px-4 py-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-4">${heading}</h1>
    ${flashHtml}
    ${errorHtml}
    <form method="post" action="${action}" class="bg-white rounded-xl shadow p-6 space-y-4">
      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Base URL</span>
        <input name="url" type="url" required value="${escHtml(url)}" placeholder="https://cms-plugin-contacts.example.workers.dev"
               class="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        <span class="block text-xs text-gray-500 mt-1">The CMS calls <code>{url}/__plugin/...</code>. Must be HTTPS (or http://localhost for dev).</span>
      </label>
      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Label <span class="text-gray-400">(optional)</span></span>
        <input name="label" type="text" value="${escHtml(label)}" placeholder="Shown until the manifest loads"
               class="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
      </label>
      <div class="flex gap-4">
        <label class="flex items-center gap-2 text-sm text-gray-700">
          <input name="enabled" type="checkbox" value="1" ${enabled ? 'checked' : ''}> Enabled
        </label>
        <label class="flex items-center gap-2 text-sm text-gray-700">
          Sort order
          <input name="sort_order" type="number" value="${escHtml(String(sortOrder))}" class="w-20 px-2 py-1 border border-gray-300 rounded-lg">
        </label>
      </div>
      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Config JSON <span class="text-gray-400">(optional)</span></span>
        <textarea name="config" rows="3" placeholder="{}"
                  class="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono">${escHtml(config)}</textarea>
      </label>
      <div class="flex gap-3 pt-2">
        <button class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">${isNew ? 'Register' : 'Save'}</button>
        <a href="/admin/plugins-manage" class="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700">Cancel</a>
      </div>
    </form>
    ${secretHtml}
  </div>`;
  return adminLayout(views, opts, { title: heading, body });
}
