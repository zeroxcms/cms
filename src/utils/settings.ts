import type { Env } from '../types';

export const SIDEBAR_MENU_SETTING_KEY = 'admin.sidebar_menu.hidden_items';
export const APP_BRANDING_SETTING_KEY = 'admin.app_branding';
export const ADMIN_HOME_SETTING_KEY = 'admin.home';
export const SYSTEM_TIMEZONE_SETTING_KEY = 'admin.system_timezone';
export const DEFAULT_SYSTEM_TIMEZONE = '+0000';

const FIXED_OFFSET_MINUTES = [
  ...Array.from({ length: 53 }, (_, index) => -720 + index * 30),
  345, 525, 765, 825,
].sort((a, b) => a - b);

export const SYSTEM_TIMEZONE_OPTIONS = [...new Set(FIXED_OFFSET_MINUTES)].map((totalMinutes) => {
  const sign = totalMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(totalMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return {
    value: `${sign}${hours}${minutes}`,
    label: `UTC${sign}${hours}:${minutes} (${sign}${hours}${minutes})`,
  };
});
export const DEFAULT_SETTINGS_GROUP_WEIGHT = 30;
export const DEFAULT_PLUGIN_NAV_WEIGHT = 35;
export const DEFAULT_PLUGIN_SETTINGS_NAV_WEIGHT = 80;

export const SIDEBAR_MENU_ITEMS = [
  { key: 'pages', label: 'Pages', description: 'Draft content dashboard and page lists.', href: '/admin/pages/list', icon: 'document', group: 'main', defaultWeight: 10 },
  { key: 'tags', label: 'Tags', description: 'Tag terms shown in the main sidebar.', href: '/admin/tags', icon: 'tag', group: 'main', defaultWeight: 20 },
  { key: 'taxonomies', label: 'Taxonomies', description: 'Taxonomy settings link.', href: '/admin/taxonomies', icon: 'list-filter', group: 'settings', defaultWeight: 10 },
  { key: 'pageTypes', label: 'Page Types', description: 'Database-defined page type settings link.', href: '/admin/page_types', icon: 'list', group: 'settings', defaultWeight: 20 },
  { key: 'blockTypes', label: 'Block Types', description: 'Database-defined block settings link.', href: '/admin/block_types', icon: 'blocks', group: 'settings', defaultWeight: 30 },
  { key: 'users', label: 'Users & Credits', description: 'User and credit management link for permitted roles.', href: '/admin/users', icon: 'users', group: 'settings', defaultWeight: 40 },
  { key: 'roles', label: 'Roles', description: 'Role and permission management link.', href: '/admin/roles', icon: 'shield-check', group: 'settings', defaultWeight: 50 },
  { key: 'plugins', label: 'Plugins', description: 'Plugin registry settings link.', href: '/admin/plugins-manage', icon: 'beaker', group: 'settings', defaultWeight: 60 },
  { key: 'credits', label: 'Credit Summary', description: 'Chargeable actions and effective prices across plugins.', href: '/admin/settings/credits', icon: 'coins', group: 'settings', defaultWeight: 65 },
  { key: 'languages', label: 'Languages', description: 'Content languages and CMS interface translations.', href: '/admin/settings/languages', icon: 'globe', group: 'settings', defaultWeight: 67 },
  { key: 'system', label: 'System', description: 'App branding, menu visibility, and menu order.', href: '/admin/settings/system', icon: 'settings', group: 'settings', defaultWeight: 70 },
  { key: 'content', label: 'Files', description: 'Media files in the bucket and the pages that reference them.', href: '/admin/settings/content', icon: 'folder', group: 'settings', defaultWeight: 80 },
  { key: 'trash', label: 'Trash', description: 'Deleted content review link.', href: '/admin/trash', icon: 'trash', group: 'main', defaultWeight: 40 },
] as const;

export const APP_ICON_OPTIONS = [
  { value: 'arrow-left', label: 'Arrow left' },
  { value: 'beaker', label: 'Beaker' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'contact-card', label: 'Contact card' },
  { value: 'chevron-down', label: 'Chevron down' },
  { value: 'chevron-right', label: 'Chevron right' },
  { value: 'clock', label: 'Clock' },
  { value: 'cloud-upload', label: 'Cloud upload' },
  { value: 'code', label: 'Code' },
  { value: 'copy', label: 'Copy' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'document', label: 'Document' },
  { value: 'coins', label: 'Coins' },
  { value: 'document-plus', label: 'Document plus' },
  { value: 'download', label: 'Download' },
  { value: 'edit-square', label: 'Edit square' },
  { value: 'eye', label: 'Eye' },
  { value: 'eye-off', label: 'Eye off' },
  { value: 'folder', label: 'Folder' },
  { value: 'globe', label: 'Globe' },
  { value: 'github', label: 'GitHub' },
  { value: 'google', label: 'Google' },
  { value: 'microsoft', label: 'Microsoft' },
  { value: 'apple', label: 'Apple' },
  { value: 'trash-can', label: 'Trash can' },
  { value: 'settings', label: 'Settings' },
  { value: 'check-circle', label: 'Check circle' },
  { value: 'key', label: 'Key' },
  { value: 'list', label: 'List' },
  { value: 'list-filter', label: 'Filtered list' },
  { value: 'logout', label: 'Log out' },
  { value: 'menu', label: 'Menu' },
  { value: 'mail-check', label: 'Email checked' },
  { value: 'moon', label: 'Moon' },
  { value: 'pencil-square', label: 'Pencil square' },
  { value: 'plus', label: 'Plus' },
  { value: 'search', label: 'Search' },
  { value: 'shield-check', label: 'Shield' },
  { value: 'sun', label: 'Sun' },
  { value: 'tag', label: 'Tag' },
  { value: 'trash', label: 'Trash' },
  { value: 'upload', label: 'Upload' },
  { value: 'user', label: 'User' },
  { value: 'user-group', label: 'User group' },
  { value: 'users', label: 'Users' },
  { value: 'warning', label: 'Warning' },
  { value: 'x', label: 'Close' },
] as const;

export type SidebarMenuItemKey = typeof SIDEBAR_MENU_ITEMS[number]['key'];
export type SidebarMenuGroup = typeof SIDEBAR_MENU_ITEMS[number]['group'];
export type SidebarMenuSettings = Record<SidebarMenuItemKey, { visible: boolean; weight: number }>;
export type AppIcon = typeof APP_ICON_OPTIONS[number]['value'];

export interface AppBrandingSettings {
  appName: string;
  appIcon: AppIcon;
}

export interface AdminHomeSettings {
  href: string;
}

export function normalizeSystemTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timeZone = value.trim().slice(0, 100);
  if (!timeZone) return null;
  const fixedOffset = /^([+-])(\d{2})(\d{2})$/.exec(timeZone);
  if (fixedOffset) {
    const totalMinutes = (fixedOffset[1] === '-' ? -1 : 1)
      * (Number(fixedOffset[2]) * 60 + Number(fixedOffset[3]));
    if (Number(fixedOffset[3]) < 60 && totalMinutes >= -720 && totalMinutes <= 840) return timeZone;
    return null;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
    return timeZone;
  } catch {
    return null;
  }
}

export async function loadSystemTimezone(env: Env): Promise<string> {
  return normalizeSystemTimezone(await getSetting(env, SYSTEM_TIMEZONE_SETTING_KEY)) ?? DEFAULT_SYSTEM_TIMEZONE;
}

export async function saveSystemTimezone(env: Env, value: unknown): Promise<string> {
  const timeZone = normalizeSystemTimezone(value);
  if (!timeZone) throw new Error('Invalid system timezone');
  await saveSetting(env, SYSTEM_TIMEZONE_SETTING_KEY, timeZone);
  return timeZone;
}

export interface SidebarChromeSettings {
  items: SidebarMenuSettings;
  settingsGroupWeight: number;
  pluginWeights: Record<string, number>;
  pluginIcons: Record<string, AppIcon>;
  hiddenPluginKeys: Set<string>;
}

const SIDEBAR_MENU_KEYS = new Set<string>(SIDEBAR_MENU_ITEMS.map((item) => item.key));
const APP_ICON_VALUES = new Set<string>(APP_ICON_OPTIONS.map((option) => option.value));

export function defaultSidebarMenuSettings(): SidebarMenuSettings {
  return Object.fromEntries(SIDEBAR_MENU_ITEMS.map((item) => [item.key, {
    visible: true,
    weight: item.defaultWeight,
  }])) as SidebarMenuSettings;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function saveSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, value).run();
}

export async function loadAppBrandingSettings(env: Env, fallbackName = '0xCMS'): Promise<AppBrandingSettings> {
  const defaults = defaultAppBrandingSettings(fallbackName);
  const raw = await getSetting(env, APP_BRANDING_SETTING_KEY);
  if (!raw) return defaults;

  try {
    const saved = JSON.parse(raw);
    const appName = typeof saved?.appName === 'string' && saved.appName.trim()
      ? saved.appName.trim()
      : defaults.appName;
    const appIcon = typeof saved?.appIcon === 'string' && APP_ICON_VALUES.has(saved.appIcon)
      ? saved.appIcon as AppIcon
      : defaults.appIcon;
    return { appName, appIcon };
  } catch (error) {
    return defaults;
  }
}

export async function saveAppBrandingSettings(env: Env, input: { appName: unknown; appIcon: unknown }, fallbackName = '0xCMS'): Promise<AppBrandingSettings> {
  const defaults = defaultAppBrandingSettings(fallbackName);
  const appName = typeof input.appName === 'string' && input.appName.trim()
    ? input.appName.trim().slice(0, 80)
    : defaults.appName;
  const appIcon = typeof input.appIcon === 'string' && APP_ICON_VALUES.has(input.appIcon)
    ? input.appIcon as AppIcon
    : defaults.appIcon;
  const settings = { appName, appIcon };
  await saveSetting(env, APP_BRANDING_SETTING_KEY, JSON.stringify(settings));
  return settings;
}

export async function loadAdminHomeSettings(env: Env): Promise<AdminHomeSettings> {
  const raw = await getSetting(env, ADMIN_HOME_SETTING_KEY);
  if (!raw) return defaultAdminHomeSettings();

  try {
    const saved = JSON.parse(raw);
    return { href: adminHomePath(saved?.href) };
  } catch (error) {
    return defaultAdminHomeSettings();
  }
}

export async function saveAdminHomeSettings(env: Env, input: { href: unknown }): Promise<AdminHomeSettings> {
  const settings = { href: adminHomePath(input.href) };
  await saveSetting(env, ADMIN_HOME_SETTING_KEY, JSON.stringify(settings));
  return settings;
}

export async function loadSidebarMenuSettings(env: Env): Promise<SidebarMenuSettings> {
  return (await loadSidebarChromeSettings(env)).items;
}

export async function loadSidebarChromeSettings(env: Env): Promise<SidebarChromeSettings> {
  const settings = defaultSidebarMenuSettings();
  let settingsGroupWeight = DEFAULT_SETTINGS_GROUP_WEIGHT;
  let pluginWeights: Record<string, number> = {};
  let pluginIcons: Record<string, AppIcon> = {};
  let hiddenPluginKeys = new Set<string>();
  const raw = await getSetting(env, SIDEBAR_MENU_SETTING_KEY);
  if (!raw) return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };

  try {
    const saved = JSON.parse(raw);
    const hidden = Array.isArray(saved)
      ? saved
      : Array.isArray(saved?.hidden)
        ? saved.hidden
        : [];
    for (const key of hidden) {
      const normalizedKey = legacySidebarMenuKey(key);
      if (normalizedKey) {
        settings[normalizedKey].visible = false;
      }
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && saved.weights && typeof saved.weights === 'object') {
      for (const item of SIDEBAR_MENU_ITEMS) {
        const legacyWeight = item.key === 'system' ? saved.weights.menu : undefined;
        const weight = finiteWeight(saved.weights[item.key] ?? legacyWeight, item.defaultWeight);
        settings[item.key].weight = weight;
      }
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      settingsGroupWeight = finiteWeight(saved.groupWeights?.settings, DEFAULT_SETTINGS_GROUP_WEIGHT);
      if (saved.pluginWeights && typeof saved.pluginWeights === 'object') {
        pluginWeights = Object.fromEntries(Object.entries(saved.pluginWeights)
          .map(([key, value]) => [key, finiteWeight(value, defaultPluginNavWeight(key))]));
      }
      if (saved.pluginIcons && typeof saved.pluginIcons === 'object') {
        pluginIcons = Object.fromEntries(Object.entries(saved.pluginIcons)
          .filter((entry): entry is [string, AppIcon] => typeof entry[1] === 'string' && APP_ICON_VALUES.has(entry[1])));
      }
      if (Array.isArray(saved.hiddenPlugins)) {
        hiddenPluginKeys = new Set(saved.hiddenPlugins.filter((key: unknown): key is string => typeof key === 'string'));
      }
    }
    settings.system.visible = true;
  } catch (error) {
    return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };
  }

  return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };
}

export async function saveSidebarMenuSettings(
  env: Env,
  visibleKeys: string[],
  weights: Record<string, unknown> = {},
  options: { settingsGroupWeight?: unknown; pluginWeights?: Record<string, unknown>; pluginIcons?: Record<string, unknown>; pluginVisibleKeys?: string[] } = {},
): Promise<SidebarChromeSettings> {
  const visible = new Set(visibleKeys.map(legacySidebarMenuKey).filter((key): key is SidebarMenuItemKey => !!key));
  visible.add('system');
  const settings = defaultSidebarMenuSettings();
  const hidden: SidebarMenuItemKey[] = [];
  const savedWeights: Record<string, number> = {};
  const pluginWeights: Record<string, number> = {};
  const pluginIcons: Record<string, AppIcon> = {};
  const hiddenPluginKeys = new Set<string>();
  const visiblePluginKeys = new Set(options.pluginVisibleKeys ?? []);
  const settingsGroupWeight = finiteWeight(options.settingsGroupWeight, DEFAULT_SETTINGS_GROUP_WEIGHT);

  for (const item of SIDEBAR_MENU_ITEMS) {
    const isVisible = visible.has(item.key);
    const weight = finiteWeight(weights[item.key], item.defaultWeight);
    settings[item.key] = { visible: isVisible, weight };
    if (!isVisible && item.key !== 'system') hidden.push(item.key);
    if (weight !== item.defaultWeight) savedWeights[item.key] = weight;
  }

  for (const [key, value] of Object.entries(options.pluginWeights ?? {})) {
    const weight = finiteWeight(value, defaultPluginNavWeight(key));
    if (weight !== defaultPluginNavWeight(key)) pluginWeights[key] = weight;
    if (!visiblePluginKeys.has(key)) hiddenPluginKeys.add(key);
  }
  for (const [key, value] of Object.entries(options.pluginIcons ?? {})) {
    if (typeof value === 'string' && APP_ICON_VALUES.has(value) && value !== 'beaker') {
      pluginIcons[key] = value as AppIcon;
    }
  }

  const groupWeights = settingsGroupWeight === DEFAULT_SETTINGS_GROUP_WEIGHT
    ? {}
    : { settings: settingsGroupWeight };
  await saveSetting(env, SIDEBAR_MENU_SETTING_KEY, JSON.stringify({
    hidden,
    weights: savedWeights,
    groupWeights,
    pluginWeights,
    pluginIcons,
    hiddenPlugins: [...hiddenPluginKeys],
  }));
  return { items: settings, settingsGroupWeight, pluginWeights, pluginIcons, hiddenPluginKeys };
}

export function pluginSidebarKey(item: { pluginId: string; href: string; group?: 'settings' }): string {
  return `plugin:${item.pluginId}:${item.group === 'settings' ? 'settings' : 'main'}:${item.href}`;
}

export function defaultPluginNavWeight(keyOrGroup?: string): number {
  return keyOrGroup?.includes(':settings:') || keyOrGroup === 'settings'
    ? DEFAULT_PLUGIN_SETTINGS_NAV_WEIGHT
    : DEFAULT_PLUGIN_NAV_WEIGHT;
}

function defaultAppBrandingSettings(fallbackName: string): AppBrandingSettings {
  return { appName: fallbackName, appIcon: 'document' };
}

function defaultAdminHomeSettings(): AdminHomeSettings {
  return { href: '/admin' };
}

function adminHomePath(value: unknown): string {
  if (typeof value !== 'string') return '/admin';
  const href = value.trim().slice(0, 300);
  if (href === '/admin' || href.startsWith('/admin/') || href.startsWith('/admin?')) return href;
  return '/admin';
}

function legacySidebarMenuKey(value: unknown): SidebarMenuItemKey | null {
  if (value === 'menu') return 'system';
  return typeof value === 'string' && SIDEBAR_MENU_KEYS.has(value) ? value as SidebarMenuItemKey : null;
}

function finiteWeight(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
