# worker-cms
Content management system on Workers

## Features

- **OAuth 2.1** login via Eventuai, GitHub, Google, Microsoft, or Apple with PKCE (Proof Key for Code Exchange); Apple ID tokens are signature- and nonce-verified
- **Dual JWT** security – short-lived access tokens (15 min) + rotatable refresh tokens (7 days) stored as httpOnly cookies; refresh tokens are hashed and stored in D1 for revocation
- **Capability-based access** – routes enforce granular permissions resolved from built-in or custom roles; delegated user/role managers cannot grant authority they do not already hold
- **Separated D1 content stores** – the CMS database keeps auth, sessions, draft, trash, taxonomy, and media metadata; the published database keeps only live content for public reads
- **Page versioning** – every save creates a new `page_versions` row; `draft_pages.current_page_version_id` points to the active version
- **Collaborative editing** – a per-page Durable Object synchronizes unsaved field operations and editor presence; a second Durable Object prevents duplicate plugin-admin form submissions
- **Private R2 media uploads** – picture fields upload to a private R2 bucket and are served back through the Worker at `/media/...`
- **Localized admin UI** – bundled Liquid catalogs, database-managed locale overrides, per-user UI locales, and locale-aware plugin views
- **Tailwind CSS + VanillaJS** admin UI with inline HTML toolbar for content editing
- **Plugins** – extend the CMS with separate Worker plugins (lifecycle hooks, content types, fields/blocks, admin pages, publish targets). See [Plugins](#plugins).
- **Pluggable publish targets** – publishing fans out to one or more adapters: the published D1 database (default), static JSON in an R2 bucket, or any plugin Worker (IPFS, webhooks, search indexes). See [Publish targets](#publish-targets).
- **Credits** – per-user balances for one-time, metered, or recurring plugin charges; atomic, overdraft-proof, ledger-audited, with admin grants, user-to-user transfers, and a shared site-wide pool that covers users who run out. See [Credits](#credits).
- **Background work** – a Queue chunks long admin jobs, while the scheduled handler ingests live-only submissions and bills due recurring credit subscriptions

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

For a new production installation, the interactive setup is the shortest path:

```bash
npm run setup
```

It creates or reuses both D1 databases, the private R2 bucket, and the admin-job
Queue; writes their identifiers plus the selected OAuth configuration to
`wrangler.toml`; and offers to apply migrations, deploy, and upload secrets.
The checked-in configuration intentionally contains no account-specific D1 or
OAuth client IDs. Continue below for the equivalent manual setup.

### 2. Create the D1 databases

```bash
npx wrangler d1 create cms
npx wrangler d1 create cms-published
```

Add the `database_id` values printed by the commands to the matching
`[[d1_databases]]` blocks in `wrangler.toml`:

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

The checked-in `wrangler.toml` uses this generic bucket name. If you choose another bucket name, update both the create command and `bucket_name`.

If uploads return a Cloudflare challenge page such as `Just a moment... Enable JavaScript and cookies to continue`, create a narrow Cloudflare skip rule for the authenticated upload endpoint. The Worker still requires a valid CMS session and editor role before writing to R2.

In the Cloudflare dashboard:

1. Go to **Security rules** or **Security > WAF > Custom rules**.
2. Create a custom rule named `Skip CMS upload challenge`.
3. Use this expression:
   ```text
(http.host eq "cms.example.com" and http.request.uri.path eq "/admin/upload" and http.request.method eq "POST")
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

### 5. Create the admin-job Queue

Long plugin actions and advanced-search bulk operations use a Queue so each
bounded batch receives a fresh Worker subrequest budget:

```bash
npx wrangler queues create cms-admin-jobs
```

If you choose another name, update both the producer and consumer entries in
`wrangler.toml`. The `PAGE_SYNC` and `FORM_ONCE` Durable Object migrations are
already declared there and are applied by Wrangler on deployment.

### 6. Configure secrets

```bash
# Random 32-byte secret for signing JWTs – e.g. openssl rand -hex 32
npx wrangler secret put JWT_SECRET
```

Then add a secret for each provider you enable (see step 7).

Create a `.dev.vars` file for local development (see `.dev.vars.example`).

### 7. Enable OAuth providers

Set `ENABLED_PROVIDERS` in `wrangler.toml` to a comma-separated list of the
providers you want to offer on the login page:

```toml
ENABLED_PROVIDERS = "eventuai,github,google,microsoft,apple"
```

Users will see one sign-in button per listed provider, in that order.
Add the client ID and secret for every provider you enable. Also set the shared
callback and canonical origin; these values are commented out in the release
configuration until a deployment chooses its hostname:

```toml
OAUTH_REDIRECT_URI = "https://cms.example.com/auth/callback"
CANONICAL_ORIGIN = "https://cms.example.com"
```

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

> **Note:** New accounts default to `viewer` unless the Eventuai provider
> supplies recognized roles on first login. Promote accounts with the SQL
> command in step 8; later OAuth logins never overwrite the stored CMS role.

### 8. Set the first user's role

After signing in for the first time, update your role to `admin` in the CMS database. Multiple roles can be stored as a comma-separated list, for example `admin,viewer`:

```bash
npx wrangler d1 execute cms --remote \
  --command "UPDATE users SET role='admin,viewer' WHERE email='you@example.com'"
```

### 9. Run locally

```bash
npm run dev
```

Visit **http://localhost:8787** → redirects to the login page.

### 10. Deploy

```bash
npm run deploy
```

---

## Plugins

The CMS can be extended with **plugins**, each of which is a separate Cloudflare
Worker registered at runtime by HTTPS URL. Registration, enable/disable,
credential rotation, delegated page-type scopes, assets, quotas, and credits are
managed under **Admin → Plugins** without redeploying the CMS.
A plugin can contribute:

- **Lifecycle hooks** – run on page `create`/`update`/`publish`/`unpublish`/`delete`
  plus `submission` when a live-only page is mirrored into draft (webhooks,
  external search indexing, cache purge, notifications). Hooks are best-effort
  and never block the editor.
- **Content types** – register new `blueprint`/`blocks`/`blockLists`/`taxonomies`/`taxonomyLists`
  that merge into the editor's config. Plugin-contributed page types, block
  types, and taxonomies appear (read-only) in **Admin → Page Types / Block Types / Taxonomies**, badged with
  the contributing plugin's name. A companion plugin can also request delegated
  access with `readTypes`/`writeTypes` to use existing page types through the
  `/__cms` API without contributing their blueprints; an admin must approve
  those delegated scopes in plugin management before they are honored. Use `"*"`
  in `readTypes` or `writeTypes` to request access to all concrete page types.
  A plugin can define `contentTypes.publishLect` keep/drop rules to minimize
  the structured fields sent to every publish target, and `autoPublishTypes`
  can republish already-live plugin-owned pages after a save.
- **Fields & blocks** – register new pagefield types and serve their Liquid
  snippets, which render through the CMS editor.
- **Edit, create & read views** – list page-type slugs in the manifest
  `editViews`, `newViews` (and/or `readViews`) to render the *whole* edit form,
  create form, or read-only view for those types yourself, instead of the
  built-in structured editor.
  See [Plugin edit views](#plugin-edit-views).
- **Admin routes + nav** – add an admin page (proxied at
  `/admin/plugins/<id>/...`) and a navigation entry. A nav item may set
  `group: 'settings'` to nest under the sidebar's **Settings** group instead of
  the top level; `roles` restricts who sees it. Plugins may also contribute
  namespaced role permissions and request hash-pinned JS/CSS assets that remain
  disabled until an admin approves them.
- **Quotas & credits** – declare page-count or operational limits and
  `page_create`, `metered`, or monthly `recurring` credit costs. The CMS stores
  admin-configured values and enforces the host-visible operations; plugins
  report metered charges and recurring usage through `/__cms`.
- **Publish targets** – declare `publishTarget: true` in the manifest to receive
  full page snapshots whenever a page is published or unpublished (pin to IPFS,
  push to a search index, trigger a static-site rebuild). Unlike hooks, publish
  calls are awaited and failures surface in the editor. See
  [Publish targets](#publish-targets).

With no plugins registered, the system is inert and adds no plugin traffic.

### Localized Liquid views

Core and plugin Liquid views share the CMS translation catalog. Use a namespaced
key and escape the translated text at its output context:

```liquid
{{ "plugin.events.guest_list" | t | escape }}
```

Bundled defaults live in `views/locales/<locale>.json`. Administrators can add
supported content/UI locales and override or extend keys at **Settings →
Languages → Translations**; database values win over bundled JSON. Missing keys
fall back through the locale's configured fallback, then English, then render as
the key itself. Plugin keys should use `plugin.<plugin-id>.*` to avoid collisions.

The `language` value used by content remains separate from the signed-in user's
`uiLocale`. `mis` is the protected default content language meaning “language
unspecified” and cannot be enabled as a UI locale. Liquid views can also use
`l10n_number` and `l10n_date`; `uiLocale` and `uiDirection` are available as
render globals for locale-aware plugin behavior.

### How it works

Each plugin Worker implements a small HTTP contract under the reserved
`/__plugin` prefix (`/manifest`, `/views/*`, `/admin/*`, `/edit`, `/hooks/<event>`).
The CMS discovers enabled plugins from its `plugins` table, fetches and validates
their manifests (including a 256 KiB response limit), forwards the signed-in user
plus that plugin's dedicated secret on outbound calls, and merges approved
contributions into the editor. The reverse `/__cms` API requires `x-plugin-id`
and the matching plugin row's own `x-plugin-secret`; the legacy environment
`PLUGIN_SECRET` is never accepted for inbound authentication.

### Plugin edit views

By default every page is edited and created through the built-in structured
editor. A plugin can take over the whole edit form, create/new form, or both for
the page types it owns by listing their slugs in the manifest:

```js
const MANIFEST = {
  id: 'events',
  // …
  contentTypes: { blueprint: { event: ['@date', 'venue'] } },
  editViews: ['event'],
  newViews: ['event'],
};
```

For a page of one of those types the CMS `POST`s the editor context to the
plugin's `/__plugin/edit` endpoint (JSON body + `x-plugin-secret` + `x-cms-user`).
`editViews` owns existing-page edit forms; `newViews` owns create forms. Existing
plugins that only declare `editViews` continue to own both edit and create forms
for backwards compatibility.

```jsonc
{
  "mode": "edit",                 // or "new"
  "action": "/admin/pages/42",    // where the plugin's <form> must POST back
  "backHref": "/admin",
  "language": "en",
  "uiLocale": "zh-hant",        // CMS controls; separate from content language
  "uiDirection": "ltr",
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
  newViews: ['event'],
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
   for a complete reference implementation).
2. Open **Admin → Plugins → Register plugin**, enter its public HTTPS base URL,
   and leave it disabled until you have reviewed its manifest and code.
3. Copy the generated dedicated secret from the plugin edit screen and store it
   on the plugin Worker with `wrangler secret put PLUGIN_SECRET`.
4. Enable the plugin and explicitly approve only the assets and delegated
   `readTypes`/`writeTypes` it needs.

> **Trust boundary:** plugin Workers receive scoped content and signed-in user
> context. Approved plugin JavaScript and proxied plugin pages execute on the
> CMS origin, so an enabled plugin is trusted application code, not a sandboxed
> third party. Review its source, pin approved asset hashes, grant least
> privilege, and rotate/revoke its dedicated secret if compromised.

### Plugin write-back authentication

Server-to-server calls from a plugin to `/__cms/*` must send:

```http
x-plugin-id: events
x-plugin-secret: <that plugin's dedicated secret>
```

Owned blueprint types are writable. Manifest `readTypes` and `writeTypes` stay
inert until an administrator approves them, including wildcard `"*"` requests.
Responses under `/__cms` use `Cache-Control: no-store`. Existing plugin rows
whose `secret` is `NULL` must be rotated in the admin before they can call this
API; they fail closed with `503 plugin_api_unavailable`.

---

## Security model and release checklist

- Keep `JWT_SECRET` and OAuth client secrets in Cloudflare secrets (or
  `.dev.vars` locally), never in `wrangler.toml` or source control. Cloudflare
  account, zone, route, D1, R2, and OAuth client IDs are identifiers, not bearer
  credentials.
- Set `CANONICAL_ORIGIN` and use HTTPS. Configure `ALLOWED_EMAIL_DOMAINS` when
  the CMS is not intended to allow open viewer registration.
- Access JWTs are intentionally short-lived (15 minutes). Refresh sessions can
  be revoked immediately, but an already-issued access token can retain its
  embedded role until it expires; use a shorter TTL or a per-request session /
  authorization-version check for deployments that require immediate demotion.
- Plugin URL validation rejects obvious private-address literals, but it is not
  a complete DNS-rebinding defense. Only users with `plugin:manage` should
  register audited plugin origins.
- Run `npm test`, `npm run type-check`, and `npm audit` before release. These
  checks are not a substitute for an independent penetration test.

---

## Credits

Some actions cost **credits**, a per-user balance the host meters and charges.
Plugins declare their chargeable actions in the manifest (`credits`); an admin
sets prices under **Plugins → Credits**. `page_create` costs are charged
automatically by the host every time a page of that type is created (both the
`/__cms` write-back API and the built-in editor); `metered` costs are reported
by the plugin via `POST /__cms/credits/charge`. Charging is atomic and
overdraft-proof — a balance can never go below zero — and every change is
appended to the `credit_ledger` audit trail shown on the profile page.

For `recurring` costs, a plugin reports the user's current usage with
`POST /__cms/credits/usage`. The five-minute scheduled handler bills due rows
monthly in advance or arrears according to the manifest, using the same atomic
ledger and shared-pool fallback. Failed payments become `past_due`; unreachable
plugins are deferred, and removed recurring costs are canceled.

**Managing balances (admin).** From **Users → _(a user)_ → Credits**, an admin
grants or deducts credits with a mandatory note. Deductions use the same
overdraft guard as spends.

**Transferring credits (any admin-area user).** From your own **Profile →
Credits**, you can send credits to another user by email. The move is atomic
and overdraft-guarded, and writes a paired ledger row on each side
(`transfer:send` / `transfer:receive`). Two rules apply: you cannot send to
yourself, and you cannot send to an administrator — admins manage credits
through the users admin above rather than by receiving transfers.

**Shared credit pool.** Besides per-user balances there is one site-wide pool
(`shared_credits`) with its own append-only ledger — it belongs to all users.
When a charged action costs more than the acting user's own balance, the pool
pays the **full** amount instead (all-or-nothing per pool, never split),
recorded in the shared ledger with that user as beneficiary; a spend fails
with 402 only when neither balance covers it. Credits flow **into** the pool
two ways: any user can donate their own credits from their **Profile**
(`shared:donate`, paired rows on both ledgers), and admins top it up — or
claw it back, note required — from the **Users** admin. Credits flow **out**
only through the automatic fallback above or through the privileged grant:
holders of the `credits:share` permission ("Transfer shared credits to a
user") get a **Grant from shared pool** form on a user's edit page that moves
pool credits into that user's balance (`shared:send` / `shared:receive`) —
users can never pull pool credits into their own account themselves. Admins
always hold the permission, and it can be granted to any custom role under
**Roles**.

---

## Database schema

The flattened initial migrations create **30 application
D1 tables**: 28 in the private CMS database and 2 in the published database.
Live page editing also uses 2 SQLite tables inside each page's Durable Object;
these are not D1 tables.

The counts below exclude D1/SQLite internal tables and Durable Object storage.
The migration history is flattened into one initial file per D1 database.
These baselines are intended for fresh databases. Do not point this release at
an existing database that recorded a different migration history without first
planning and verifying a schema migration; Wrangler does not re-run a modified
`0001` that a database has already recorded.

An upgraded deployment may show additional legacy `live_*` tables in `DB`;
current CMS routes ignore those tables and use `PUBLISHED_DB` instead.

### CMS database (`DB`) — 28 tables

The private schema is divided into five feature categories:

- **Content (13)**
  - Page lifecycle: `draft_pages`, `page_versions`, `trash_pages`, `trash_page_versions`
  - Classification: `taxonomies`, `tags`, `draft_page_tags`, `trash_page_tags`
  - Content model and media: `page_types`, `block_types`, `media_files`
  - Localization: `locales`, `locale_messages`
- **Identity and access (5)**
  - `users`, `user_oauth_identities`, `sessions`, `roles`, `role_permissions`
- **Credits (4)**
  - `credit_ledger`, `shared_credits`, `shared_credit_ledger`, `credit_subscriptions`
- **Plugin (5)**
  - `plugins`, `plugin_asset_approvals`, `plugin_page_type_approvals`, `settings`, `admin_jobs`
- **Compliance (1)**
  - `audit_log`

`admin_jobs` is grouped with Plugin because it coordinates long-running plugin
admin actions, although it also runs advanced-search bulk actions. The general
`settings` table is grouped there because it stores runtime CMS and plugin
configuration.

### Published database (`PUBLISHED_DB`) — 2 tables

| Table | Purpose |
|-------|---------|
| `live_pages` | Published page metadata and structured `lect` content |
| `live_page_tags` | Published page ↔ tag relationships |

Keeping public content in this separate database allows a public Worker to read
published pages without receiving access to users, sessions, drafts, trash,
plugin configuration, or other private CMS state.

### Durable Object storage

Each `PageSyncDO` page object creates two SQLite tables:

| Table | Purpose |
|-------|---------|
| `crdt_ops` | Unsaved per-user field operations that form the live collaborative editing overlay; cleared after a save |
| `presence` | Currently connected editors and their last-seen/last-active state |

These tables are created in Durable Object SQLite storage, not by the D1
migration directories. `FormOnceDO` separately stores short-lived, hashed
single-use form claims in Durable Object key/value storage across 64 shards;
it does not create application SQL tables.

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
`uuid`, preserving the draft page's numeric `id`, and replaces its
`live_page_tags` links; un-publish deletes both.

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
using that registration's dedicated secret. Two ready-to-deploy plugins:

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
│   ├── durable-objects/
│   │   ├── page-sync.ts # Collaborative edit overlay and presence
│   │   └── form-once.ts # Single-use admin form claims
│   ├── middleware/
│   │   ├── auth.ts    # Dual-JWT auth + capability guard
│   │   └── rate-limit.ts
│   ├── plugins/       # Registry, hooks, proxy views, and config validation
│   ├── publish/
│   │   ├── adapter.ts # PublishAdapter contract + snapshot types
│   │   ├── d1.ts      # D1 target (published database, default)
│   │   ├── r2.ts      # R2 target (static JSON snapshots)
│   │   ├── plugin.ts  # Plugin-Worker target (/__plugin/publish/*)
│   │   └── index.ts   # Registry: resolves targets, fans out publishes
│   ├── routes/
│   │   ├── auth.ts    # OAuth 2.1 login / callback / logout / refresh
│   │   ├── cms-api.ts # Authenticated plugin-facing /__cms API
│   │   ├── media.ts   # Private R2 media delivery
│   │   └── admin/     # Capability-protected admin route modules
│   ├── security/      # JWT, cookies, sessions, HTTP, media, plugin proxy
│   ├── templates/     # Server renderers for Liquid section data
│   └── utils/
│       ├── admin-job-runner.ts # Queue-backed admin job batches
│       ├── credit-subscriptions.ts # Scheduled recurring billing
│       ├── lect.ts    # Structured content helpers
│       ├── pkce.ts    # PKCE code verifier / challenge helpers
│       └── submission-ingest.ts # Published-to-draft submission mirroring
├── views/
│   ├── layout/        # Liquid layout
│   ├── sections/      # Admin UI Liquid sections
│   ├── templates/     # Section composition maps
│   └── assets/        # Compiled Tailwind CSS and browser scripts
├── styles/
│   └── admin.css      # Tailwind source stylesheet
├── package.json
├── tsconfig.json
└── wrangler.toml
```
