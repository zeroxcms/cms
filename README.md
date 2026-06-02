# worker-cms
Content management system on Workers

## Features

- **OAuth 2.1** login via Eventuai, GitHub, or Google with PKCE (Proof Key for Code Exchange)
- **Dual JWT** security – short-lived access tokens (15 min) + rotatable refresh tokens (7 days) stored as httpOnly cookies; refresh tokens are hashed and stored in D1 for revocation
- **Role-based access** – users with `admin`, `editor`, or `moderator` in their comma-separated role list can access the CMS; other users are redirected to the login page
- **Single content database** – draft, live, and trash content live in one D1 database using separate table prefixes
- **Page versioning** – every save creates a new `draft_page_versions` row; `draft_pages.current_page_version_id` points to the active version
- **Tailwind CSS + VanillaJS** admin UI with inline HTML toolbar for content editing

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 databases

```bash
npx wrangler d1 create cms-content
npx wrangler d1 create cms-auth
```

Copy the `database_id` values printed by each command into `wrangler.toml`.

For an existing deployment, update the `CONTENT_DB` binding to point at the one
database you want to keep. Existing rows from the old live/draft/trash databases
must be copied into the new prefixed tables separately.

### 3. Run migrations

```bash
# CONTENT_DB (draft/live/trash content tables)
npx wrangler d1 migrations apply cms-content

# AUTH_DB (users and refresh sessions)
npx wrangler d1 migrations apply cms-auth
```

The content migration creates `draft_*`, `live_*`, and `trash_*` tables in one
database. It does not automatically import rows from other D1 databases.

### 4. Configure secrets

```bash
# Random 32-byte secret for signing JWTs – e.g. openssl rand -hex 32
npx wrangler secret put JWT_SECRET
```

Then add a secret for each provider you enable (see step 5).

Create a `.dev.vars` file for local development (see `.dev.vars.example`).

### 5. Enable OAuth providers

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
> Promote accounts to `admin` / `editor` with the SQL command in step 6.

### 6. Set the first user's role

After signing in for the first time, update your role to `admin` in the auth database. Multiple roles can be stored as a comma-separated list, for example `admin,viewer`:

```bash
npx wrangler d1 execute cms-auth --remote \
  --command "UPDATE users SET role='admin,viewer' WHERE email='you@example.com'"
```

### 7. Run locally

```bash
npm run dev
```

Visit **http://localhost:8787** → redirects to the login page.

### 8. Deploy

```bash
npm run deploy
```

---

## Database schema

### Content tables (CONTENT_DB only)

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

### Auth tables (AUTH_DB only)

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
│   ├── auth/          # Applied to AUTH_DB
│   └── content/       # Applied to CONTENT_DB
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
