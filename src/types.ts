// ============================================================
// Shared TypeScript types
// ============================================================

export type UserRole = 'admin' | 'editor' | 'moderator' | 'viewer';

export const EDITOR_ROLES: UserRole[] = ['admin', 'editor', 'moderator'];

export interface User {
  id: number;
  oauth_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: UserRole;
}

// Access token – short-lived (15 min)
// Refresh token – long-lived (7 days), also stored in DB for revocation
export interface JWTPayload {
  sub: string;         // user id
  email: string;
  name: string;
  role: UserRole;
  type: 'access' | 'refresh';
  jti?: string;        // unique token id (refresh tokens only)
  exp: number;
  iat: number;
}

export interface Page {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  page_type: string | null;
  current_page_version_id: number | null;
  original: string | null;
  page_id: number | null;
}

export interface PageVersion {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  page_id: number;
  content: string | null;
  meta: string | null;
}

export interface PageTag {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  page_id: number | null;
  tag_id: number;
  weight: number;
}

export interface Tag {
  id: number;
  uuid: string;
  name: string;
  slug: string;
}

// ============================================================
// Cloudflare Worker environment bindings
// ============================================================
export interface Env {
  LIVE_DB: D1Database;
  DRAFT_DB: D1Database;
  TRASH_DB: D1Database;
  /** HMAC-SHA256 secret for signing JWTs – set via `wrangler secret put JWT_SECRET` */
  JWT_SECRET: string;
  /** OAuth 2.1 provider: "github" or "google" */
  OAUTH_PROVIDER: string;
  OAUTH_CLIENT_ID: string;
  /** Set via `wrangler secret put OAUTH_CLIENT_SECRET` */
  OAUTH_CLIENT_SECRET: string;
  /** Full redirect URI registered with OAuth provider */
  OAUTH_REDIRECT_URI: string;
  SITE_TITLE: string;
}

// Hono context variables set by the auth middleware
export interface Variables {
  user: JWTPayload;
}
