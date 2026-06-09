# cms-plugin-events

Reference plugin for the Worker CMS. It is a standalone Cloudflare Worker that the
CMS calls over a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
It demonstrates all four plugin extension points in one small file
(`src/index.ts`):

| Capability | What this plugin does |
|------------|-----------------------|
| Content types | Registers an `event` blueprint (`@date`, `venue`, `location:events-map`, `speakers[]`). |
| Fields & blocks | Registers an `events-map` field type and serves its Liquid snippet. |
| Lifecycle hooks | Subscribes to `publish` / `unpublish` / `delete` and logs the payload. |
| Admin routes + nav | Adds an **Events** nav item and renders a page at `/admin/plugins/events/dashboard`. |

## The plugin contract

A plugin is any Worker that answers these requests under the reserved
`/__plugin` prefix:

| Route | Purpose |
|-------|---------|
| `GET /__plugin/manifest` | Returns the JSON manifest (id, name, hooks, nav, contentTypes, fieldTypes). |
| `GET /__plugin/views/*` | Serves the plugin's Liquid templates (field/block snippets). |
| `ALL /__plugin/admin/*` | Renders the plugin's admin pages. Receives `x-cms-user`. |
| `POST /__plugin/hooks/<event>` | Receives `{ event, page, user }` for a subscribed lifecycle event. |

Hook and admin calls carry an `x-plugin-secret` header equal to the CMS
`PLUGIN_SECRET`, so the plugin can verify the request came from the CMS.

## Deploy + wire into the CMS

```bash
cd examples/plugin-events
npm install
npx wrangler secret put PLUGIN_SECRET   # same value as the CMS PLUGIN_SECRET
npx wrangler deploy
```

Then, in the CMS `wrangler.toml`:

```toml
[[services]]
binding = "PLUGIN_EVENTS"
service = "cms-plugin-events"

[vars]
PLUGINS = "PLUGIN_EVENTS"
```

Set the matching secret on the CMS too: `wrangler secret put PLUGIN_SECRET`.
Redeploy the CMS. The **Events** nav item appears, the `event` page type becomes
available in the editor, and publishing fires this plugin's `publish` hook
(visible in `wrangler tail cms-plugin-events`).
