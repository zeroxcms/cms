// ============================================================
// Shared TypeScript types
// ============================================================

import type { BlueprintEntry } from './cms-config';
import type { CmsAdminJobMessage } from './utils/admin-jobs';

declare global {
  /** Query surface shared by a raw D1 binding and a D1 Sessions API client. */
  type D1DatabaseClient = Pick<D1DatabaseSession, 'prepare' | 'batch'>;
}

export const USER_ROLES = ['admin', 'editor', 'moderator', 'viewer'] as const;

export type UserRole = typeof USER_ROLES[number];

export const EDITOR_ROLES: UserRole[] = ['admin', 'editor', 'moderator'];

// ── Capability-based authorization ────────────────────────────────────────────
// Roles are mapped to a least-privilege set of capabilities; routes require a
// specific capability rather than just "is an editor". See utils/roles.ts.
export const PERMISSIONS = [
  'content:read',     // view draft page metadata and editor-side read APIs
  'content:write',    // create / edit pages, weight, page-tag associations
  'content:publish',  // publish / unpublish
  'content:delete',   // move a page to trash (soft delete)
  'content:import',   // CSV / JSON bulk import
  'trash:restore',    // restore a page from trash
  'trash:purge',      // permanently delete from trash (destructive)
  'tag:write',        // create / edit / delete tags (terms)
  'taxonomy:write',   // create / edit / delete taxonomies
  'media:upload',     // upload media to R2
  'plugin:access',    // reach the plugin admin proxy
  'plugin:manage',    // register / enable / disable / configure plugins
  'menu:manage',      // configure admin system/menu settings
  'pagetype:write',   // create / edit / delete database-defined page types
  'blocktype:write',  // create / edit / delete database-defined block types
  'users:manage',     // view users and assign their roles
  'roles:manage',     // create / edit / delete roles and their permissions
  'credits:share',    // transfer credits from the shared pool to a user
] as const;

export type Permission = typeof PERMISSIONS[number];

/** Human-readable descriptions for the Roles admin permission picker. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'content:read': 'View draft content metadata',
  'content:write': 'Create and edit pages',
  'content:publish': 'Publish and unpublish pages',
  'content:delete': 'Move pages to trash',
  'content:import': 'Bulk import (CSV / JSON)',
  'trash:restore': 'Restore pages from trash',
  'trash:purge': 'Permanently delete from trash',
  'tag:write': 'Create and edit tags',
  'taxonomy:write': 'Manage taxonomies',
  'media:upload': 'Upload media',
  'plugin:access': 'Reach the plugin admin',
  'plugin:manage': 'Register and configure plugins',
  'menu:manage': 'Manage system settings',
  'pagetype:write': 'Manage page types',
  'blocktype:write': 'Manage block types',
  'users:manage': 'Manage users and their roles',
  'roles:manage': 'Manage roles and permissions',
  'credits:share': 'Transfer shared credits to a user',
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
  /** Credit balance (see utils/credits.ts). Optional on partial SELECTs. */
  credits?: number;
}

// Access token – short-lived (15 min)
// Refresh token – long-lived (7 days), also stored in DB for revocation
export interface JWTPayload {
  sub: string;         // user id
  email: string;
  name: string;
  role: string;
  type: 'access' | 'refresh' | 'oauth_state'; // 'oauth_state' = short-lived PKCE state cookie, never an auth token
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
  /** IANA timezone name (e.g. 'Asia/Hong_Kong') for the start/end window. */
  timezone: string | null;
  page_type: string | null;
  current_page_version_id?: number | null;
  lect: string | null;
  page_id: number | null;
  /** Original draft parent id retained while a child page sits in trash. */
  source_page_id?: number | null;
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
  weight: number;
  taxonomy_slug: string | null;
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

/** A registered plugin (URL transport) stored in the `plugins` table. The CMS
 *  reaches it at `{url}/__plugin/...`; see src/plugins/registry.ts. */
export interface PluginRecord {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  label: string;
  url: string;
  /** 1 = active; 0 = registered but inert. */
  enabled: number;
  config: string | null;
  sort_order: number;
  /** Per-plugin shared secret. Null = fall back to the env PLUGIN_SECRET. */
  secret: string | null;
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
  /** Which sidebar group the item belongs to. "settings" nests it under the
   *  Settings group; omitted (default) places it at the top level. */
  group?: 'settings';
}

export interface PluginFieldType {
  /** Field type id; resolves to /snippets/pagefield/<type>/basic.liquid. Namespace by plugin id. */
  type: string;
}

/**
 * Publish-time lect projection for one page type. `keep` retains ONLY the
 * listed top-level fields (structural `_`-prefixed keys always survive);
 * `drop` removes the listed fields and keeps everything else. When both are
 * set, `keep` wins. Data minimization: the published DB is read by
 * public-facing Workers, so fields no published-side consumer needs (PII,
 * secrets) should never land there.
 */
export interface PublishLectRule {
  keep?: string[];
  drop?: string[];
}

/** Content-type fragments a plugin merges into the effective CmsConfig. */
export interface PluginContentTypes {
  blueprint?: Record<string, BlueprintEntry[]>;
  blocks?: Record<string, BlueprintEntry[]>;
  blockLists?: Record<string, string[]>;
  /**
   * Publish-time lect projection per page type this plugin OWNS (declared in
   * `blueprint`). Rules for types the plugin does not own are ignored — a
   * plugin must not be able to thin out another plugin's published pages.
   */
  publishLect?: Record<string, PublishLectRule>;
  /** Taxonomy definitions keyed by slug; values are display names. */
  taxonomies?: Record<string, string>;
  taxonomyLists?: Record<string, string[]>;
  /**
   * Page types this plugin may WRITE through the write-back API without
   * contributing/owning their blueprint. Use this for companion plugins that
   * mutate another plugin's pages by explicit delegation. Admin approval is
   * required before the CMS honors each declared write scope. Use `*` to request
   * write access to every concrete page type.
   */
  writeTypes?: string[];
  /**
   * Page types this plugin may READ (but not write) through the write-back API,
   * in addition to the types it owns via `blueprint` or may write via
   * `writeTypes`. Lets a plugin pull data from pages another plugin owns —
   * e.g. the events suite reading `contact` pages to refresh a guest. Admin
   * approval is required before the CMS honors each declared read scope. Use `*`
   * to request read access to every concrete page type.
   */
  readTypes?: string[];
}

/** Page lifecycle events a plugin can subscribe to through manifest.hooks. */
export type PluginHookEvent = 'create' | 'submission' | 'update' | 'publish' | 'unpublish' | 'delete';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Plugin Worker deploy revision. Plugins should expose CF_VERSION_METADATA.id here when available. */
  workerVersionId?: string;
  /** Snake-case alias for plugin manifests that expose worker_version_id. */
  worker_version_id?: string;
  /** Optional structured Worker version metadata, if the plugin chooses to expose it. */
  workerVersion?: string | Pick<WorkerVersionMetadata, 'id' | 'tag' | 'timestamp'>;
  /** Back-compat alias for plugins that expose Cloudflare metadata verbatim. */
  cfVersionMetadata?: Pick<WorkerVersionMetadata, 'id' | 'tag' | 'timestamp'>;
  CF_VERSION_METADATA?: Pick<WorkerVersionMetadata, 'id' | 'tag' | 'timestamp'>;
  /** Lifecycle events the plugin wants to receive. `submission` is emitted for
   *  pages found in the published database without a draft counterpart. */
  hooks?: PluginHookEvent[];
  /** Plugin-owned page types that should be republished after each save once
   *  they are already live. Types must also be declared in contentTypes.blueprint;
   *  the first publish always remains an explicit editor action. */
  autoPublishTypes?: string[];
  /** When true, the plugin is a publish target: it receives full page
   *  snapshots on publish/unpublish via /__plugin/publish/*. */
  publishTarget?: boolean;
  nav?: PluginNavItem[];
  contentTypes?: PluginContentTypes;
  fieldTypes?: PluginFieldType[];
  /**
   * Page-type slugs whose edit view this plugin renders itself. For a page of
   * one of these types the CMS POSTs the editor context to the plugin's
   * `/__plugin/edit` endpoint and wraps the returned HTML fragment in the admin
   * chrome instead of rendering the built-in editor. The plugin's form posts
   * back to the CMS's normal save handler, so save/version/publish logic is
   * unchanged. A 404 (or any error) from the plugin falls back to the built-in
   * editor. For backwards compatibility, `editViews` also owns the create/new
   * view unless `newViews` is declared by a plugin for that page type. See
   * src/plugins/edit-view.ts.
   */
  editViews?: string[];
  /**
   * Page-type slugs whose create/new view this plugin renders itself. The CMS
   * POSTs the same editor context to `/__plugin/edit`, with `mode: "new"` and
   * `action` pointing at the CMS create handler. This lets a plugin override
   * creation without overriding the edit view for existing pages.
   */
  newViews?: string[];
  /**
   * Page-type slugs whose read-only view this plugin renders itself. For a page
   * of one of these types the CMS POSTs the read context to the plugin's
   * `/__plugin/read` endpoint and wraps the returned HTML fragment in the admin
   * chrome instead of rendering the built-in read view. A 404 (or any error)
   * from the plugin falls back to the built-in read view, and `?native=1`
   * forces it. Independent of `editViews`: a plugin may own the edit view, the
   * read view, both, or neither. See src/plugins/edit-view.ts (pluginReadView).
   */
  readViews?: string[];
  /**
   * Additional permission types this plugin contributes. They appear in the
   * Roles admin alongside built-in permissions so editors can grant them to
   * custom roles. Values should be namespaced by plugin id (e.g. "events:manage").
   */
  permissions?: Array<{ value: string; label: string }>;
  /**
   * Static JS/CSS files this plugin wants to execute/apply inside CMS chrome
   * (e.g. a live camera scanner). Declaring a file here only makes it eligible
   * for approval — an admin must still explicitly approve each path (pinning
   * its content hash) from the plugin's admin-registry page before
   * client-render.js will let it survive sanitization. Path is relative to the
   * plugin's own origin, e.g. "/assets/js/kiosk.js". See utils/plugin-assets.ts.
   */
  assets?: Array<{ path: string; label?: string }>;
  /**
   * Quota definitions this plugin exposes for admin configuration. The plugin
   * only *declares* which limits exist (key, counting scope, optional target
   * page type/default); the CMS stores configured values in the `settings`
   * table. It enforces page quotas on every create path; plugins enforce
   * operational limits such as per-second delivery rates. See
   * utils/plugin-limits.ts.
   */
  limits?: PluginLimitDef[];
  /**
   * Credit costs this plugin exposes for admin configuration. Like limits, the
   * plugin only *declares* which chargeable actions exist; the CMS stores the
   * configured prices in the `settings` table, deducts from the acting user's
   * balance, and records every change in the credit ledger. See
   * utils/credits.ts.
   */
  credits?: PluginCreditDef[];
}

/** How a declared plugin limit counts existing pages. */
export type PluginLimitScope = 'total' | 'per_parent' | 'per_pointer' | 'per_second';

/** A quota declared in a plugin manifest (see PluginManifest.limits). */
export interface PluginLimitDef {
  /** Identifier unique within the plugin, e.g. "max_guests_per_list". */
  key: string;
  /** Human label shown in the limits admin. */
  label?: string;
  /** Optional longer description shown in the limits admin. */
  description?: string;
  /** Page type whose creation this limit bounds. Must be a type the plugin owns
   *  via its blueprint or may write via an approved writeType. */
  page_type?: string;
  /**
   * Counting scope: 'total' counts all pages of the type; 'per_parent' counts
   * siblings under one parent page (page_id); 'per_pointer' counts pages
   * sharing one `_pointers.<pointer_key>` value (e.g. guests in a guest list).
   * 'per_second' is an operational limit read and enforced by the plugin; it
   * does not apply to page creation and does not require page_type.
   */
  scope: PluginLimitScope;
  /** Required when scope is 'per_pointer': the `_pointers` key pages group by. */
  pointer_key?: string;
  /** Limit applied until an admin configures a value. Omitted → unlimited. */
  default?: number;
}

/**
 * How a declared credit cost is charged: 'page_create' costs are observed and
 * charged by the host at every page-create path; 'metered' costs are reported
 * by the plugin via POST /__cms/credits/charge for actions the host can't see
 * (e.g. sending an EDM blast).
 */
export type PluginCreditCharge = 'page_create' | 'metered';

/** A credit cost declared in a plugin manifest (see PluginManifest.credits). */
export interface PluginCreditDef {
  /** Identifier unique within the plugin, e.g. "create_guest_list". */
  key: string;
  /** Human label shown in the credits admin and the ledger. */
  label?: string;
  /** Optional longer description shown in the credits admin. */
  description?: string;
  charge: PluginCreditCharge;
  /** Required when charge is 'page_create': the page type whose creation is
   *  charged. Must be a type the plugin owns or may write via an approved
   *  writeType. */
  page_type?: string;
  /** Display unit for metered costs (e.g. "recipient"); defaults to "action". */
  unit?: string;
  /** Cost in credits until an admin configures a value. Omitted or 0 = free —
   *  a freshly deployed manifest never silently starts charging. */
  default?: number;
}

/** An admin-approved plugin asset (see PluginManifest.assets), stored in the
 *  `plugin_asset_approvals` table. `integrity` is the SRI hash (sha384-...) of
 *  the file's bytes pinned at approval time. */
export interface PluginAssetApproval {
  id: number;
  plugin_id: string;
  path: string;
  integrity: string;
  approved_by: string;
  created_at: string;
  updated_at: string;
}

export type PluginPageTypeAccess = 'read' | 'write';

/** An admin-approved delegated page-type scope (see PluginContentTypes
 *  readTypes/writeTypes), stored in the `plugin_page_type_approvals` table. */
export interface PluginPageTypeApproval {
  id: number;
  plugin_id: string;
  page_type: string;
  access: PluginPageTypeAccess;
  approved_by: string;
  created_at: string;
  updated_at: string;
}

/** A resolved, active plugin: its declared binding name, Fetcher, and manifest. */
export interface ResolvedPlugin {
  binding: string;
  fetcher: Fetcher;
  manifest: PluginManifest;
  /** Effective shared secret for this plugin (its own, or the env fallback). Empty when neither is set. */
  secret: string;
  /** Admin-entered display label from the plugin row (Plugins → edit → Label). Empty when unset. */
  label?: string;
}

// ============================================================
// Cloudflare Worker environment bindings
// ============================================================
export interface Env {
  DB: D1DatabaseClient;
  PUBLISHED_DB: D1DatabaseClient;
  VIEWS: Fetcher;
  /** Cloudflare Worker version metadata; changes on every deploy. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Optional manual fallback for local/dev environments without version metadata. */
  VIEW_REVISION?: string;
  MEDIA_BUCKET?: R2Bucket;
  /** Comma-separated built-in publish targets ("d1", "r2"). Defaults to "d1".
   *  Plugin publish targets are discovered from manifests, not listed here. */
  PUBLISH_TARGETS?: string;
  /** Bucket for the "r2" publish target (static JSON snapshots). */
  PUBLISH_BUCKET?: R2Bucket;
  PAGE_SYNC: DurableObjectNamespace;
  /** Sharded single-use admin form-token coordinators. */
  FORM_ONCE: DurableObjectNamespace;
  /** Comma-separated list of plugin service-binding names, e.g. "PLUGIN_EVENTS,PLUGIN_SEO". */
  PLUGINS?: string;
  /** Shared secret forwarded to plugin Workers so they can trust CMS-originated calls. */
  PLUGIN_SECRET?: string;
  /** Queue for CMS-owned admin background jobs, such as long plugin actions. */
  ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage>;
  /** HMAC-SHA256 secret for signing JWTs – set via `wrangler secret put JWT_SECRET` */
  JWT_SECRET: string;
  /**
   * Comma-separated list of enabled OAuth providers,
   * e.g. "github,google,microsoft,apple,eventuai".
   * Only providers listed here will show as login options.
   */
  ENABLED_PROVIDERS: string;
  /** Per-provider OAuth client IDs (set in wrangler.toml [vars]) */
  GITHUB_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_TENANT?: string;
  APPLE_CLIENT_ID?: string;
  EVENTUAI_CLIENT_ID?: string;
  /** Per-provider OAuth client secrets (set via `wrangler secret put`) */
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  APPLE_CLIENT_SECRET?: string;
  EVENTUAI_CLIENT_SECRET?: string;
  /** Shared OAuth redirect URI registered with all providers */
  OAUTH_REDIRECT_URI: string;
  CANONICAL_ORIGIN?: string;
  SITE_TITLE: string;
  /** Default timezone for a page's start/end window when none is set.
   *  UTC offset (e.g. "+0800") or IANA name. Falls back to "+0800". */
  DEFAULT_TIMEZONE?: string;
  /**
   * Optional comma-separated email-domain allowlist for new sign-ups,
   * e.g. "cowise.co,eventuai.com". Unset = open registration (viewer role).
   */
  ALLOWED_EMAIL_DOMAINS?: string;
  /** Workers Rate Limiting bindings (optional – absent in local dev/tests). */
  AUTH_RATE_LIMITER?: RateLimiter;
  UPLOAD_RATE_LIMITER?: RateLimiter;
}

/** Raw bindings supplied by Cloudflare before request/job-scoped sessions are created. */
export type WorkerEnv = Omit<Env, 'DB' | 'PUBLISHED_DB'> & {
  DB: D1Database;
  PUBLISHED_DB: D1Database;
};

/** Shape of a Workers Rate Limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Hono context variables set by the auth middleware
export interface Variables {
  user: JWTPayload;
}
