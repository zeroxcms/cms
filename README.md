# worker-cms
Content management system on Workers

## Features

- **OAuth 2.1** login via GitHub or Google with PKCE (Proof Key for Code Exchange)
- **Dual JWT** security – short-lived access tokens (15 min) + rotatable refresh tokens (7 days) stored as httpOnly cookies; refresh tokens are hashed and stored in D1 for revocation
- **Role-based access** – only `admin`, `editor`, and `moderator` roles can access the CMS; other users are redirected to the login page
- **LIVE / DRAFT databases** – content is authored in the DRAFT D1 database, published to the LIVE D1 database with a single click, and un-published by deleting the LIVE record
- **Page versioning** – every save creates a new `page_versions` row; `pages.current_page_version_id` points to the active version
- **Tailwind CSS + VanillaJS** admin UI with inline HTML toolbar for content editing

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 databases

```bash
npx wrangler d1 create cms-live
npx wrangler d1 create cms-draft
```

Copy the `database_id` values printed by each command into `wrangler.toml`.

### 3. Run migrations

```bash
# LIVE DB (content + auth tables)
npx wrangler d1 migrations apply cms-live

# DRAFT DB (content tables only)
npx wrangler d1 migrations apply cms-draft
```

### 4. Configure secrets

```bash
# Random 32-byte secret for signing JWTs – e.g. openssl rand -hex 32
npx wrangler secret put JWT_SECRET

# OAuth application client secret
npx wrangler secret put OAUTH_CLIENT_SECRET
```

Create a `.dev.vars` file for local development (see `.dev.vars.example`).

### 5. Configure OAuth

#### GitHub
1. Go to **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set **Authorization callback URL** to `http://localhost:8787/auth/callback` (dev) or your production URL
3. Copy the **Client ID** into `wrangler.toml` (`OAUTH_CLIENT_ID`)
4. Generate a **Client Secret** and store it: `npx wrangler secret put OAUTH_CLIENT_SECRET`

#### Google
1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add the redirect URI and copy Client ID / Secret
4. Set `OAUTH_PROVIDER = "google"` in `wrangler.toml`

### 6. Set the first user's role

After signing in for the first time, update your role to `admin` in the LIVE database:

```bash
npx wrangler d1 execute cms-live \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com'"
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

### Content tables (LIVE & DRAFT)

| Table | Purpose |
|-------|---------|
| `pages` | Page metadata (name, slug, type, dates, hierarchy) |
| `page_versions` | Versioned HTML content + JSON meta per page |
| `page_tags` | Many-to-many page ↔ tag relationships |
| `tags` | Tag reference table |

### Auth tables (LIVE only)

| Table | Purpose |
|-------|---------|
| `users` | OAuth user profiles + role assignment |
| `sessions` | Hashed refresh-token JTIs for revocation |

### Publish / un-publish flow

```
DRAFT DB ──── Publish ────▶  LIVE DB   (public website reads here)
         ◀─── Un-publish ───
```

Publish copies both the `pages` row and its current `page_versions` row into LIVE (upserted by `uuid`).  
Un-publish deletes the `pages` row from LIVE (cascade removes its versions and page_tags).

---

## Project structure

```
├── migrations/
│   ├── live/          # Applied to LIVE_DB (content + auth)
│   └── draft/         # Applied to DRAFT_DB (content only)
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
