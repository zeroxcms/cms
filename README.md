# worker-cms
Content management system on Workers

## Features

- **OAuth 2.1** login via Eventuai, GitHub, or Google with PKCE (Proof Key for Code Exchange)
- **Dual JWT** security – short-lived access tokens (15 min) + rotatable refresh tokens (7 days) stored as httpOnly cookies; refresh tokens are hashed and stored in D1 for revocation
- **Role-based access** – users with `admin`, `editor`, or `moderator` in their comma-separated role list can access the CMS; other users are redirected to the login page
- **Separated D1 content stores** – the CMS database keeps auth, sessions, draft, trash, taxonomy, and media metadata; the published database keeps only live content for public reads
- **Page versioning** – every save creates a new `page_versions` row; `draft_pages.current_page_version_id` points to the active version
- **Private R2 media uploads** – picture fields upload to a private R2 bucket and are served back through the Worker at `/media/...`
- **Tailwind CSS + VanillaJS** admin UI with inline HTML toolbar for content editing
- **Plugins** – extend the CMS with separate Worker plugins (lifecycle hooks, content types, fields/blocks, admin pages, publish targets). See [Plugins](#plugins).
- **Pluggable publish targets** – publishing fans out to one or more adapters: the published D1 database (default), static JSON in an R2 bucket, or any plugin Worker (IPFS, webhooks, search indexes). See [Publish targets](#publish-targets).

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 databases

```bash
npx wrangler d1 create cms
npx wrangler d1 create cms-published
```

Copy the `database_id` values printed by the commands into `wrangler.toml`:

- `cms` -> `DB`
- `cms-published` -> `PUBLISHED_DB`

`DB` is the private CMS/admin database. It stores users, sessions, drafts,
trash, taxonomy, page versions, and media metadata.

`PUBLISHED_DB` is the published-content database. It stores the `live_pages`
and `live_page_tags` rows used by public readers. A separate public Worker can
be deployed with only this binding, so it has no access to CMS users, sessions,
drafts, or trash.

For an existing deployment, keep the existing `DB` binding and create the new
`PUBLISHED_DB`. Existing rows from old `live_*` tables are not moved
automatically; publish pages again or copy the current `live_pages` and
`live_page_tags` rows into `cms-published`. Older deployed CMS databases may
still contain legacy `live_*` tables, but CMS routes ignore them after this
change.

### 3. Run migrations

```bash
npx wrangler d1 migrations apply cms
npx wrangler d1 migrations apply cms-published
```

For local development, the checked-in script applies both local databases:

```bash
npm run db:migrate
```

For production, add `--remote` to each `wrangler d1 migrations apply` command.

The `cms` migrations create auth tables plus draft, trash, taxonomy,
versioning, media tables, and the CMS-owned `admin_jobs` table for durable
background admin actions such as long plugin duplicate/delete requests. The
`cms-published` migrations create only the published `live_*` content tables.
They do not automatically import rows from other D1 databases.

### 4. Create and bind the private R2 media bucket

Picture fields upload files to the `MEDIA_BUCKET` R2 binding. R2 buckets are not public by default; this CMS keeps the bucket private and serves objects through the Worker at `/media/<key>`.

Create the bucket:

```bash
npx wrangler r2 bucket create worker-cms-media
```

Bind it in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "worker-cms-media"
```

The checked-in `wrangler.toml` already contains this binding. If you choose another bucket name, update both the create command and `bucket_name`.

If uploads return a Cloudflare challenge page such as `Just a moment... Enable JavaScript and cookies to continue`, create a narrow Cloudflare skip rule for the authenticated upload endpoint. The Worker still requires a valid CMS session and editor role before writing to R2.

In the Cloudflare dashboard:

1. Go to **Security rules** or **Security > WAF > Custom rules**.
2. Create a custom rule named `Skip CMS upload challenge`.
3. Use this expression:
   ```text
(http.host eq "cms.eventuai.com" and http.request.uri.path eq "/admin/upload" and http.request.method eq "POST")
   ```
4. Set **Action** to **Skip**.
5. Select the product that appears in **Security > Events** for the failed upload, commonly **All managed rules**, **All Super Bot Fight Mode rules**, **Browser Integrity Check**, or **Security Level**.
6. Save the rule and retry the upload.

Cloudflare Bot Fight Mode on the Free plan cannot be skipped by a custom rule. If Security Events shows Bot Fight Mode, disable Bot Fight Mode for the zone or move to Super Bot Fight Mode/Bot Management so this endpoint can be exempted.

The page editor uses a Worker-owned preview route for picture field thumbnails:

```text
/media-preview/<key>
```

In production, `/media-preview/<key>` fetches the private R2-backed `/media/<key>` URL with Cloudflare Image Resizing options:

```ts
cf: { image: { width: 100, height: 100, fit: 'cover' } }
```

Enable **Images > Transformations** for the zone before relying on this optimization. If transformations are not enabled, the route falls back to the original `/media/<key>` object for preview display.

### 5. Configure secrets

```bash
# Random 32-byte secret for signing JWTs – e.g. openssl rand -hex 32
npx wrangler secret put JWT_SECRET
```

Then add a secret for each provider you enable (see step 6).

Create a `.dev.vars` file for local development (see `.dev.vars.example`).

### 6. Enable OAuth providers

Set `ENABLED_PROVIDERS` in `wrangler.toml` to a comma-separated list of the
providers you want to offer on the login page:

```toml
ENABLED_PROVIDERS = "eventuai,github,google,microsoft,apple"
```

Users will see one sign-in button per listed provider, in that order.
Add the Client ID and secret for every provider you enable.

To link an additional OAuth provider to the same CMS account, sign in first,
then start that provider's flow from the profile page (or use
`/auth/start?provider=google&link=1`).
The callback attaches the new provider identity to the current user; it will
not silently merge logged-out accounts just because their emails match.

#### Eventuai (self-hosted OAuth worker)

1. Register the CMS as a client on your OAuth worker — see the OAuth worker README for the `POST /admin/setup-clients` call.
2. Copy the generated `clientId` into `wrangler.toml`:
   ```toml
   EVENTUAI_CLIENT_ID = "<client-id>"
   ```
3. Store the matching secret:
   ```bash
   npx wrangler secret put EVENTUAI_CLIENT_SECRET
   ```

#### GitHub

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set **Authorization callback URL** to your `OAUTH_REDIRECT_URI` (e.g. `https://cms.example.com/auth/callback`).
3. Copy the **Client ID** into `wrangler.toml`:
   ```toml
   GITHUB_CLIENT_ID = "<client-id>"
   ```
4. Generate a **Client Secret** and store it:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

#### Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth 2.0 Client ID** (type: *Web application*).
3. Add your `OAUTH_REDIRECT_URI` as an authorised redirect URI.
4. Copy the **Client ID** into `wrangler.toml`:
   ```toml
   GOOGLE_CLIENT_ID = "<client-id>"
   ```
5. Store the **Client Secret**:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

#### Microsoft

1. Open **Microsoft Entra admin center → App registrations → New registration**.
2. Add your `OAUTH_REDIRECT_URI` as a web redirect URI.
3. Copy the **Application (client) ID** into `wrangler.toml`:
   ```toml
   MICROSOFT_CLIENT_ID = "<client-id>"
   ```
4. Optionally set `MICROSOFT_TENANT` to `common`, `organizations`, `consumers`, or a tenant ID/domain. It defaults to `common`.
5. Store the client secret:
   ```bash
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   ```

#### Apple

1. In Apple Developer, configure **Sign in with Apple** for your Services ID.
2. Add your `OAUTH_REDIRECT_URI` as a return URL.
3. Copy the Services ID into `wrangler.toml`:
   ```toml
   APPLE_CLIENT_ID = "<services-id>"
   ```
4. Generate an Apple client-secret JWT for that Services ID and store it:
   ```bash
   npx wrangler secret put APPLE_CLIENT_SECRET
   ```

> **Note:** GitHub and Google users have their role defaulted from the database.
> Promote accounts to `admin` / `editor` with the SQL command in step 7.

### 7. Set the first user's role

After signing in for the first time, update your role to `admin` in the CMS database. Multiple roles can be stored as a comma-separated list, for example `admin,viewer`:

```bash
npx wrangler d1 execute cms --remote \
  --command "UPDATE users SET role='admin,viewer' WHERE email='you@example.com'"
```

### 8. Run locally

```bash
npm run dev
```

Visit **http://localhost:8787** → redirects to the login page.

### 9. Deploy

```bash
npm run deploy
```

---

## Plugins

The CMS can be extended with **plugins**, each of which is a separate Cloudflare
Worker bound to the CMS as a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
A plugin can add six things:

- **Lifecycle hooks** – run on page `create`/`update`/`publish`/`unpublish`/`delete`
  (webhooks, external search indexing, cache purge, notifications). Hooks are
  best-effort and never block the editor.
- **Content types** – register new `blueprint`/`blocks`/`blockLists`/`taxonomyLists`
  that merge into the editor's config. Plugin-contributed page types and block
  types appear (read-only) in **Admin → Page Types / Block Types**, badged with
  the contributing plugin's name. A companion plugin can also request delegated
  access with `readTypes`/`writeTypes` to use existing page types through the
  `/__cms` API without contributing their blueprints; an admin must approve
  those delegated scopes in plugin management before they are honored.
- **Fields & blocks** – register new pagefield types and serve their Liquid
  snippets, which render through the CMS editor.
- **Edit & read views** – list page-type slugs in the manifest `editViews`
  (and/or `readViews`) to render the *whole* edit/new form — or the read-only
  view — for those types yourself, instead of the built-in structured editor.
  See [Plugin edit views](#plugin-edit-views).
- **Admin routes + nav** – add an admin page (proxied at
  `/admin/plugins/<id>/...`) and a navigation entry. A nav item may set
  `group: 'settings'` to nest under the sidebar's **Settings** group instead of
  the top level; `roles` restricts who sees it.
- **Publish targets** – declare `publishTarget: true` in the manifest to receive
  full page snapshots whenever a page is published or unpublished (pin to IPFS,
  push to a search index, trigger a static-site rebuild). Unlike hooks, publish
  calls are awaited and failures surface in the editor. See
  [Publish targets](#publish-targets).

Adding a plugin is a `wrangler.toml` change plus a redeploy — there is no runtime
install. With no plugins configured (`PLUGINS` unset) the system is inert and adds
no overhead.

### How it works

Each plugin Worker implements a small HTTP contract under the reserved
`/__plugin` prefix (`/manifest`, `/views/*`, `/admin/*`, `/edit`, `/hooks/<event>`).
The CMS discovers plugins from the comma-separated `PLUGINS` var (binding names),
fetches and caches their manifests, forwards the signed-in user plus a shared
`PLUGIN_SECRET` on every call, and merges their contributions into the editor.

### Plugin edit views

By default every page is edited through the built-in structured editor. A plugin
can take over the whole edit/new form for the page types it owns by listing their
slugs in the manifest:

```js
const MANIFEST = {
  id: 'events',
  // …
  contentTypes: { blueprint: { event: ['@date', 'venue'] } },
  editViews: ['event'],
};
```

For a page of one of those types the CMS `POST`s the editor context to the
plugin's `/__plugin/edit` endpoint (JSON body + `x-plugin-secret` + `x-cms-user`):

```jsonc
{
  "mode": "edit",                 // or "new"
  "action": "/admin/pages/42",    // where the plugin's <form> must POST back
  "backHref": "/admin",
  "language": "en",
  "pageType": "event",
  "page": { "id": 42, "name": "…", "slug": "…", "weight": 5,
            "start": null, "end": null, "timezone": "+0800",
            "editors": null, "lect": "{…stringified lect JSON…}" },
  "versions": [{ "id": 9, "created_at": "…", "action": "update" }],
  "flash": "…", "errors": ["…"]
}
```

The plugin returns an **HTML fragment** with `x-cms-chrome: 1` (and optionally a
percent-encoded `x-cms-title`); the CMS wraps it in the standard admin chrome and
serves it under the CMS origin. The fragment's `<form>` posts back to `action`
using the normal CMS field-name conventions (`@attr`, `.field|<lang>`, `*pointer`,
plus `name`/`slug`/`weight`/`page_type`/`action`), so save, versioning, and
publish all flow through the CMS's existing handler unchanged. Returning `404`
(or any error / non-HTML response) makes the CMS fall back to the built-in editor,
so a half-built plugin can never lock an editor out of a page. Like proxied admin
pages, the wrapped fragment runs under the CMS's strict nonce CSP — contribute
any field markup through Liquid snippets / view files rather than inline scripts.

To bypass a plugin edit view and use the built-in structured editor for a single
page, append **`?native=1`** (or `?editor=cms`) to the edit URL, e.g.
`/admin/pages/42/edit?native=1`. The flag is carried through the editor's form
action and post-save redirect, so it survives validation errors and reloads.

#### Read views

Every page also has a built-in **read-only view** at `/admin/pages/<id>/read`
(the eye icon on the dashboard, or *View* in the editor header): the same
structured content rendered as static text instead of inputs. A plugin can take
over that view for the page types it owns exactly like the edit view — list the
slugs under `readViews` (independent of `editViews`; a plugin may own the edit
view, the read view, both, or neither):

```js
const MANIFEST = {
  id: 'events',
  // …
  editViews: ['event'],
  readViews: ['event'],
};
```

For a page of one of those types the CMS `POST`s a read context to the plugin's
`/__plugin/read` endpoint (JSON body + `x-plugin-secret` + `x-cms-user`). It
mirrors the edit context but omits the form-submission fields (`mode`, `action`,
`flash`, `errors`) and adds `editHref` — a link back to the CMS editor:

```jsonc
{
  "editHref": "/admin/pages/42/edit",
  "backHref": "/admin",
  "language": "en",
  "pageType": "event",
  "page": { "id": 42, "name": "…", "slug": "…", "weight": 5,
            "start": null, "end": null, "timezone": "+0800",
            "editors": null, "lect": "{…stringified lect JSON…}" },
  "versions": [{ "id": 9, "created_at": "…", "action": "update" }]
}
```

The plugin returns an **HTML fragment** with `x-cms-chrome: 1` (and optionally a
percent-encoded `x-cms-title`), wrapped in the standard admin chrome under the
strict nonce CSP — just like the edit view. Returning `404` (or any error /
non-HTML response) falls back to the built-in read view, and `?native=1`
(or `?editor=cms`) forces it, so a half-built plugin can never hide a page.

Admin responses are `X-Frame-Options: DENY` by default. A plugin **full-document**
admin response (no `x-cms-chrome`) may opt into being shown in a same-origin
`<iframe>` by setting `x-cms-frame: 1`; the proxy translates it to
`X-Frame-Options: SAMEORIGIN` with `frame-ancestors 'self'` (e.g. an EDM editor
embedding its own email preview). It is same-origin only — the response is still
served on the CMS origin.

### Adding a plugin

1. Build/deploy the plugin Worker (see [`examples/plugin-events`](examples/plugin-events)
   for a complete reference implementing all six capabilities).
2. Bind it in `wrangler.toml` and list its binding name in `PLUGINS`:
   ```toml
   [[services]]
   binding = "PLUGIN_EVENTS"
   service = "cms-plugin-events"

   [vars]
   PLUGINS = "PLUGIN_EVENTS"
   ```
3. Share the secret with both Workers: `wrangler secret put PLUGIN_SECRET`.
4. Redeploy the CMS.

> **Trust:** plugin Workers receive page content and the signed-in user. Only
> bind plugins you trust.

---

## Database schema

### CMS database (`DB`)

| Table | Purpose |
|-------|---------|
| `draft_pages` | Draft page metadata (name, slug, type, dates, hierarchy) |
| `trash_pages` | Soft-deleted page metadata |
| `page_versions` | Versioned draft structured content per page |
| `draft_page_tags` | Many-to-many draft page ↔ tag relationships |
| `trash_page_tags` | Many-to-many trash page ↔ tag relationships |
| `taxonomies` | Taxonomy definitions (groupings that tags belong to) |
| `tags` | Shared tag reference table (terms within a taxonomy) |
| `media_files` | Metadata for files uploaded to private R2 |

### Auth tables (`DB`)

| Table | Purpose |
|-------|---------|
| `users` | OAuth user profiles + role assignment |
| `user_oauth_identities` | Linked OAuth provider identities for each user |
| `sessions` | Hashed refresh-token JTIs for revocation |

### Published database (`PUBLISHED_DB`)

| Table | Purpose |
|-------|---------|
| `live_pages` | Published page metadata and structured `lect` content |
| `live_page_tags` | Published page ↔ tag relationships |

### Publish / un-publish flow

```
                       ┌────▶  d1      PUBLISHED_DB.live_pages (default)
DB.draft_pages ── Publish ──▶  r2      PUBLISH_BUCKET pages/<uuid>.json + index.json
                       └────▶  plugin  /__plugin/publish/* (IPFS, webhooks, …)
```

Publish builds one snapshot from `DB.draft_pages` (page row + denormalized tag
links) and fans it out to every configured **publish target**; un-publish and
page deletion remove the page from every target the same way. See
[Publish targets](#publish-targets).

The default `d1` target upserts the snapshot into `PUBLISHED_DB.live_pages` by
`uuid` and replaces its `live_page_tags` links; un-publish deletes both.

## Publish targets

Publishing is adapter-based (`src/publish/`). Built-in targets are selected with
the `PUBLISH_TARGETS` var (comma-separated, defaults to `"d1"`):

| Target | Requires | What it does |
|--------|----------|--------------|
| `d1` | `PUBLISHED_DB` binding | Upserts `live_pages` / `live_page_tags` in the published database (the original flow) |
| `r2` | `PUBLISH_BUCKET` binding | Writes static JSON: `pages/<uuid>.json` (full snapshot, `lect` parsed) plus `index.json` (listing of all live pages) |

```toml
[[r2_buckets]]
binding = "PUBLISH_BUCKET"
bucket_name = "worker-cms-published"

[vars]
PUBLISH_TARGETS = "d1,r2"
```

**Plugin targets** are not listed in `PUBLISH_TARGETS`; any plugin whose
manifest declares `publishTarget: true` automatically receives publish traffic
(requires `PLUGIN_SECRET`). Two ready-to-deploy plugins:

- [`plugin-publish-ipfs`](https://github.com/zeroxcms/plugin-publish-ipfs) — pins
  each published page to IPFS via the Pinata API, tracks `uuid → CID` in KV so
  un-publish unpins.
- [`plugin-publish-webhook`](https://github.com/zeroxcms/plugin-publish-webhook) —
  forwards publish events to external URLs as HMAC-signed JSON webhooks (search
  indexers, static-site rebuilds, deploy hooks).

The contract is three POST endpoints, JSON body, `x-plugin-secret` header:

| Endpoint | Body | When |
|----------|------|------|
| `/__plugin/publish/page` | `{ page, tags, publishedAt }` | page published |
| `/__plugin/publish/remove` | `{ uuid }` | page unpublished or deleted |
| `/__plugin/publish/remove-tag` | `{ tagId }` | tag deleted (optional — a 404 is ignored) |

All targets are awaited on publish; per-target failures are logged and reported
in the editor flash message (`Page published, but these targets failed: …`)
without blocking the targets that succeeded.

The admin UI's publish-status badges read live state from the first configured
target that supports reads (`d1`, or `r2` when `d1` is absent). Plugin targets
are write-only.

---

## Project structure

```
├── migrations/
│   ├── 0001_initial_schema.sql
│   └── published/
│       └── 0001_published_schema.sql
├── src/
│   ├── index.ts       # Hono app entry point
│   ├── types.ts       # Shared TypeScript types & Env bindings
│   ├── middleware/
│   │   └── auth.ts    # Dual-JWT auth + editor-role guard
│   ├── publish/
│   │   ├── adapter.ts # PublishAdapter contract + snapshot types
│   │   ├── d1.ts      # D1 target (published database, default)
│   │   ├── r2.ts      # R2 target (static JSON snapshots)
│   │   ├── plugin.ts  # Plugin-Worker target (/__plugin/publish/*)
│   │   └── index.ts   # Registry: resolves targets, fans out publishes
│   ├── routes/
│   │   ├── auth.ts    # OAuth 2.1 login / callback / logout / refresh
│   │   └── admin.ts   # Protected CMS admin UI routes
│   ├── templates/
│   │   ├── layout.ts  # Shared HTML wrapper (Tailwind CDN)
│   │   ├── login.ts   # Login page
│   │   ├── dashboard.ts # Pages list with publish status
│   │   └── editor.ts  # Create / edit page form
│   └── utils/
│       ├── jwt.ts     # HS256 sign / verify using Web Crypto API
│       ├── lect.ts    # Structured content helpers
│       └── pkce.ts    # PKCE code verifier / challenge helpers
├── package.json
├── tsconfig.json
└── wrangler.toml
```
