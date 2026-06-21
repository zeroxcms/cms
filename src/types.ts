// ============================================================
// Shared TypeScript types
// ============================================================

import type { BlueprintEntry } from './cms-config';

export const USER_ROLES = ['admin', 'editor', 'moderator', 'viewer'] as const;

export type UserRole = typeof USER_ROLES[number];

export const EDITOR_ROLES: UserRole[] = ['admin', 'editor', 'moderator'];

// ── Capability-based authorization ────────────────────────────────────────────
// Roles are mapped to a least-privilege set of capabilities; routes require a
// specific capability rather than just "is an editor". See utils/roles.ts.
export const PERMISSIONS = [
  'content:write',    // create / edit pages, weight, page-tag associations
  'content:publish',  // publish / unpublish
  'content:delete',   // move a page to trash (soft delete)
  'content:import',   // CSV / JSON bulk import
  'trash:restore',    // restore a page from trash
  'trash:purge',      // permanently delete from trash (destructive)
  'taxonomy:write',   // create / edit / delete tags and taxonomies
  'media:upload',     // upload media to R2
  'plugin:access',    // reach the plugin admin proxy
  'pagetype:write',   // create / edit / delete database-defined page types
  'blocktype:write',  // create / edit / delete database-defined block types
  'users:manage',     // view users and assign their roles
  'roles:manage',     // create / edit / delete roles and their permissions
] as const;

export type Permission = typeof PERMISSIONS[number];

/** Human-readable descriptions for the Roles admin permission picker. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'content:write': 'Create and edit pages',
  'content:publish': 'Publish and unpublish pages',
  'content:delete': 'Move pages to trash',
  'content:import': 'Bulk import (CSV / JSON)',
  'trash:restore': 'Restore pages from trash',
  'trash:purge': 'Permanently delete from trash',
  'taxonomy:write': 'Manage tags and taxonomies',
  'media:upload': 'Upload media',
  'plugin:access': 'Reach the plugin admin',
  'pagetype:write': 'Manage page types',
  'blocktype:write': 'Manage block types',
  'users:manage': 'Manage users and their roles',
  'roles:manage': 'Manage roles and permissions',
};

/** A role with a stored permission set (custom role, or a customized built-in). */
export interface Role {
  name: string;
  label: string;
  builtin: number;
  created_at: string;
  updated_at: string;
}

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
  taxonomy_id: number | null;
  parent_tag: number | null;
  lect: string | null;
}

export interface Taxonomy {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
}

/** A runtime-editable page type stored in the `page_types` table. */
export interface PageType {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  /** The page-type key (e.g. 'event'); becomes the blueprint map key. */
  slug: string;
  name: string;
  /** JSON array of BlueprintEntry. */
  blueprint: string;
  /** Optional JSON arrays of names (block-type slugs / taxonomy slugs). */
  block_lists: string | null;
  taxonomy_lists: string | null;
  weight: number;
}

/** A runtime-editable block definition stored in the `block_types` table. */
export interface BlockType {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  /** The block-type key (e.g. 'logos'); becomes the blocks map key. */
  slug: string;
  name: string;
  /** JSON array of BlueprintEntry for this block's fields. */
  blueprint: string;
  weight: number;
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
  taxonomyLists?: Record<string, string[]>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Lifecycle events the plugin wants to receive (e.g. "publish", "delete"). */
  hooks?: string[];
  /** When true, the plugin is a publish target: it receives full page
   *  snapshots on publish/unpublish via /__plugin/publish/*. */
  publishTarget?: boolean;
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
  /** Comma-separated built-in publish targets ("d1", "r2"). Defaults to "d1".
   *  Plugin publish targets are discovered from manifests, not listed here. */
  PUBLISH_TARGETS?: string;
  /** Bucket for the "r2" publish target (static JSON snapshots). */
  PUBLISH_BUCKET?: R2Bucket;
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
  /**
   * Optional comma-separated email-domain allowlist for new sign-ups,
   * e.g. "cowise.co,eventuai.com". Unset = open registration (viewer role).
   */
  ALLOWED_EMAIL_DOMAINS?: string;
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
