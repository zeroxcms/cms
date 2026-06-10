// ============================================================
// Shared TypeScript types
// ============================================================

import type { BlueprintEntry } from './cms-config';

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
  iss?: string;        // always set by signJWT; verified on every token
  aud?: string;        // always set by signJWT; verified on every token
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
  creator: number | null;
  editors: string | null;
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
// Plugins (service-binding model — each plugin is its own Worker)
// ============================================================

export interface PluginNavItem {
  /** Display label shown in the admin navigation. */
  label: string;
  /** Path relative to the plugin's admin mount, e.g. "events" → /admin/plugins/<id>/events. */
  href: string;
  /** Roles allowed to see the item; omit/empty to show for all editor roles. */
  roles?: string[];
}

export interface PluginFieldType {
  /** Field type id; resolves to /snippets/pagefield/<type>/basic.liquid. Namespace by plugin id. */
  type: string;
}

/** Content-type fragments a plugin merges into the effective CmsConfig. */
export interface PluginContentTypes {
  blueprint?: Record<string, BlueprintEntry[]>;
  blocks?: Record<string, BlueprintEntry[]>;
  blockLists?: Record<string, string[]>;
  tagLists?: Record<string, string[]>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Lifecycle events the plugin wants to receive (e.g. "publish", "delete"). */
  hooks?: string[];
  nav?: PluginNavItem[];
  contentTypes?: PluginContentTypes;
  fieldTypes?: PluginFieldType[];
}

/** A resolved, active plugin: its declared binding name, Fetcher, and manifest. */
export interface ResolvedPlugin {
  binding: string;
  fetcher: Fetcher;
  manifest: PluginManifest;
}

// ============================================================
// Cloudflare Worker environment bindings
// ============================================================
export interface Env {
  DB: D1Database;
  PUBLISHED_DB: D1Database;
  VIEWS: Fetcher;
  MEDIA_BUCKET?: R2Bucket;
  PAGE_SYNC: DurableObjectNamespace;
  /** Comma-separated list of plugin service-binding names, e.g. "PLUGIN_EVENTS,PLUGIN_SEO". */
  PLUGINS?: string;
  /** Shared secret forwarded to plugin Workers so they can trust CMS-originated calls. */
  PLUGIN_SECRET?: string;
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
  /** Workers Rate Limiting bindings (optional – absent in local dev/tests). */
  AUTH_RATE_LIMITER?: RateLimiter;
  UPLOAD_RATE_LIMITER?: RateLimiter;
}

/** Shape of a Workers Rate Limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Hono context variables set by the auth middleware
export interface Variables {
  user: JWTPayload;
}
