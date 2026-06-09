// ============================================================
// Reference Worker CMS plugin — "events".
//
// A self-contained Cloudflare Worker that implements the CMS plugin
// contract over the reserved /__plugin/* prefix. It exercises all
// four extension points:
//   - content types  : registers an `event` blueprint
//   - fields & blocks : registers an `events-map` field + its snippet
//   - lifecycle hooks : logs publish/unpublish/delete
//   - admin + nav     : an "Events" nav item + a proxied admin page
//
// Bind it into the CMS as a service binding and list its binding name
// in the CMS `PLUGINS` var. See README.md.
// ============================================================

interface PluginEnv {
  /** Shared secret the CMS forwards on every call (set via `wrangler secret put`). */
  PLUGIN_SECRET?: string;
}

const MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  hooks: ['publish', 'unpublish', 'delete'],
  nav: [{ label: 'Events', href: 'dashboard', roles: ['admin', 'editor'] }],
  contentTypes: {
    blueprint: {
      event: ['@date', 'venue', 'location:events-map', { speakers: ['name'] }],
    },
  },
  fieldTypes: [{ type: 'events-map' }],
};

// Liquid snippet for the `events-map` field, served to the CMS Liquid engine.
// Receives the same `field`/`values`/`names` data as core pagefield snippets.
const EVENTS_MAP_SNIPPET = `<label for="{{ field.id | escape }}" class="min-w-0 block">
  <span class="block text-sm font-medium text-gray-700 mb-1">{{ field.label | escape }} (lat,lng)</span>
  <input id="{{ field.id | escape }}" type="text" name="{{ field.inputName | escape }}"
         value="{{ field.value | escape }}"
         placeholder="51.5074,-0.1278"
         class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
</label>
`;

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Defense in depth: hooks and admin require the shared secret. Manifest and
    // view files are harmless to serve, and the binding is private anyway.
    const secretRequired = path.startsWith('/__plugin/hooks/') || path.startsWith('/__plugin/admin');
    if (secretRequired && env.PLUGIN_SECRET && request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path === '/__plugin/views/snippets/pagefield/events-map/basic.liquid') {
      return new Response(EVENTS_MAP_SNIPPET, { headers: { 'content-type': 'text/plain' } });
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const event = path.split('/').pop();
      const payload = await request.json().catch(() => ({}));
      console.log(`[events plugin] hook ${event}:`, JSON.stringify(payload));
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/admin')) {
      const user = parseUser(request.headers.get('x-cms-user'));
      return new Response(adminDashboard(user), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  },
};

function parseUser(header: string | null): { name?: string; role?: string } {
  if (!header) return {};
  try {
    return JSON.parse(header) as { name?: string; role?: string };
  } catch {
    return {};
  }
}

function adminDashboard(user: { name?: string; role?: string }): string {
  const name = (user.name ?? 'there').replace(/</g, '&lt;');
  const role = (user.role ?? '').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Events</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8">
  <div class="max-w-2xl mx-auto bg-white rounded-xl shadow p-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-2">Events plugin</h1>
    <p class="text-gray-600">Hello, ${name}${role ? ` (${role})` : ''}.</p>
    <p class="text-gray-600 mt-4">This page is served by the <code>events</code> plugin Worker and
    proxied through the CMS at <code>/admin/plugins/events/dashboard</code>.</p>
  </div>
</body>
</html>`;
}
