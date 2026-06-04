# worker-cms
Content management system on Workers

## Features

- **OAuth 2.1** login via Eventuai, GitHub, or Google with PKCE (Proof Key for Code Exchange)
- **Dual JWT** security – short-lived access tokens (15 min) + rotatable refresh tokens (7 days) stored as httpOnly cookies; refresh tokens are hashed and stored in D1 for revocation
- **Role-based access** – users with `admin`, `editor`, or `moderator` in their comma-separated role list can access the CMS; other users are redirected to the login page
- **Single D1 database** – auth, sessions, draft, live, and trash content live in one CMS database
- **Page versioning** – every save creates a new `draft_page_versions` row; `draft_pages.current_page_version_id` points to the active version
- **Private R2 media uploads** – picture fields upload to a private R2 bucket and are served back through the Worker at `/media/...`
- **Tailwind CSS + VanillaJS** admin UI with inline HTML toolbar for content editing

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 database

```bash
npx wrangler d1 create cms
```

Copy the `database_id` value printed by the command into `wrangler.toml`.

For an existing deployment, update the `DB` binding to point at the one database
you want to keep. Existing rows from the old auth/content databases must be
copied into the merged database separately.

### 3. Run migrations

```bash
npx wrangler d1 migrations apply cms
```

The migrations create auth tables plus `draft_*`, `live_*`, and `trash_*`
content tables. They do not automatically import rows from other D1 databases.

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

The page editor uses Cloudflare Image Resizing for picture field previews, requesting only a 100x100 thumbnail:

```text
/cdn-cgi/image/width=100,height=100,fit=cover/media/<key>
```

Enable **Images > Transformations** for the zone before relying on this optimization. If transformations are not enabled, the editor falls back to the original `/media/<key>` URL for preview display.

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
ENABLED_PROVIDERS = "eventuai,github,google"
```

Users will see one sign-in button per listed provider, in that order.
Add the Client ID and secret for every provider you enable.

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

## Database schema

### Content tables

| Table | Purpose |
|-------|---------|
| `draft_pages` | Draft page metadata (name, slug, type, dates, hierarchy) |
| `live_pages` | Published page metadata |
| `trash_pages` | Soft-deleted page metadata |
| `draft_page_versions` | Versioned draft HTML content + JSON meta per page |
| `trash_page_versions` | Versioned trashed HTML content + JSON meta per page |
| `draft_page_tags` | Many-to-many draft page ↔ tag relationships |
| `trash_page_tags` | Many-to-many trash page ↔ tag relationships |
| `tags` | Shared tag reference table |
| `media_files` | Metadata for files uploaded to private R2 |

### Auth tables

| Table | Purpose |
|-------|---------|
| `users` | OAuth user profiles + role assignment |
| `sessions` | Hashed refresh-token JTIs for revocation |

### Publish / un-publish flow

```
draft_pages ──── Publish ────▶  live_pages   (public website reads here)
            ◀─── Un-publish ───
```

Publish upserts the `draft_pages` row into `live_pages` by `uuid`.
Un-publish deletes the matching `live_pages` row by `uuid`.

---

## Project structure

```
├── migrations/
│   ├── 0001_auth_schema.sql
│   └── 0002_single_content_schema.sql
├── src/
│   ├── index.ts       # Hono app entry point
│   ├── types.ts       # Shared TypeScript types & Env bindings
│   ├── middleware/
│   │   └── auth.ts    # Dual-JWT auth + editor-role guard
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
│       └── pkce.ts    # PKCE code verifier / challenge helpers
├── package.json
├── tsconfig.json
└── wrangler.toml
```
