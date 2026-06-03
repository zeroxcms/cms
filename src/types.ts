// ============================================================
// Shared TypeScript types
// ============================================================

export const USER_ROLES = ['admin', 'editor', 'moderator', 'viewer'] as const;

export type UserRole = typeof USER_ROLES[number];

export const EDITOR_ROLES: UserRole[] = ['admin', 'editor', 'moderator'];

export interface User {
  id: number;
  oauth_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: string;
}

// Access token – short-lived (15 min)
// Refresh token – long-lived (7 days), also stored in DB for revocation
export interface JWTPayload {
  sub: string;         // user id
  email: string;
  name: string;
  role: string;
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
  current_page_version_id?: number | null;
  lect: string | null;
  page_id: number | null;
}

export interface PageVersion {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  page_id: number;
  lect: string | null;
  action: string | null;
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
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  tag_type_id: number | null;
  parent_tag: number | null;
  lect: string | null;
}

export interface TagType {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
}

export interface MediaFile {
  id: number;
  uuid: string;
  created_at: string;
  key: string;
  url: string;
  filename: string;
  content_type: string | null;
  size: number;
}

// ============================================================
// Cloudflare Worker environment bindings
// ============================================================
export interface Env {
  DB: D1Database;
  MEDIA_BUCKET?: R2Bucket;
  /** HMAC-SHA256 secret for signing JWTs – set via `wrangler secret put JWT_SECRET` */
  JWT_SECRET: string;
  /**
   * Comma-separated list of enabled OAuth providers, e.g. "github,google,eventuai".
   * Only providers listed here will show as login options.
   */
  ENABLED_PROVIDERS: string;
  /** Per-provider OAuth client IDs (set in wrangler.toml [vars]) */
  GITHUB_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  EVENTUAI_CLIENT_ID?: string;
  /** Per-provider OAuth client secrets (set via `wrangler secret put`) */
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  EVENTUAI_CLIENT_SECRET?: string;
  /** Shared OAuth redirect URI registered with all providers */
  OAUTH_REDIRECT_URI: string;
  CANONICAL_ORIGIN?: string;
  SITE_TITLE: string;
}

// Hono context variables set by the auth middleware
export interface Variables {
  user: JWTPayload;
}
