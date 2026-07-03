import type { Env } from '../types';

export const SIDEBAR_MENU_SETTING_KEY = 'admin.sidebar_menu.hidden_items';

export const SIDEBAR_MENU_ITEMS = [
  { key: 'pages', label: 'Pages', description: 'Draft content dashboard and page lists.' },
  { key: 'tags', label: 'Tags', description: 'Tag terms shown in the main sidebar.' },
  { key: 'taxonomies', label: 'Taxonomies', description: 'Taxonomy settings link.' },
  { key: 'pageTypes', label: 'Page Types', description: 'Database-defined page type settings link.' },
  { key: 'blockTypes', label: 'Block Types', description: 'Database-defined block settings link.' },
  { key: 'users', label: 'Users', description: 'User management link for permitted roles.' },
  { key: 'roles', label: 'Roles', description: 'Role and permission management link.' },
  { key: 'plugins', label: 'Plugins', description: 'Plugin registry settings link.' },
  { key: 'trash', label: 'Trash', description: 'Deleted content review link.' },
] as const;

export type SidebarMenuItemKey = typeof SIDEBAR_MENU_ITEMS[number]['key'];
export type SidebarMenuSettings = Record<SidebarMenuItemKey, boolean>;

const SIDEBAR_MENU_KEYS = new Set<string>(SIDEBAR_MENU_ITEMS.map((item) => item.key));

export function defaultSidebarMenuSettings(): SidebarMenuSettings {
  return Object.fromEntries(SIDEBAR_MENU_ITEMS.map((item) => [item.key, true])) as SidebarMenuSettings;
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

export async function loadSidebarMenuSettings(env: Env): Promise<SidebarMenuSettings> {
  const settings = defaultSidebarMenuSettings();
  const raw = await getSetting(env, SIDEBAR_MENU_SETTING_KEY);
  if (!raw) return settings;

  try {
    const hidden = JSON.parse(raw);
    if (!Array.isArray(hidden)) return settings;
    for (const key of hidden) {
      if (typeof key === 'string' && SIDEBAR_MENU_KEYS.has(key)) {
        settings[key as SidebarMenuItemKey] = false;
      }
    }
  } catch (error) {
    return settings;
  }

  return settings;
}

export async function saveSidebarMenuSettings(env: Env, visibleKeys: string[]): Promise<SidebarMenuSettings> {
  const visible = new Set(visibleKeys.filter((key) => SIDEBAR_MENU_KEYS.has(key)));
  const settings = defaultSidebarMenuSettings();
  const hidden: SidebarMenuItemKey[] = [];

  for (const item of SIDEBAR_MENU_ITEMS) {
    const isVisible = visible.has(item.key);
    settings[item.key] = isVisible;
    if (!isVisible) hidden.push(item.key);
  }

  await saveSetting(env, SIDEBAR_MENU_SETTING_KEY, JSON.stringify(hidden));
  return settings;
}
