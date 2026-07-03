import { Hono } from 'hono';
import { requirePermission } from '../../middleware/auth';
import { systemSettingsPage } from '../../templates/settings';
import type { Env, Variables } from '../../types';
import { pluginNav } from '../../plugins/registry';
import { logAudit } from '../../utils/audit';
import { renderPage } from '../../utils/admin-render';
import {
  APP_ICON_OPTIONS,
  SIDEBAR_MENU_ITEMS,
  defaultPluginNavWeight,
  loadAppBrandingSettings,
  loadSidebarChromeSettings,
  pluginSidebarKey,
  saveAppBrandingSettings,
  saveSidebarMenuSettings,
} from '../../utils/settings';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.use('/settings/system', requirePermission('menu:manage'));
settingsRoutes.use('/settings/menu', requirePermission('menu:manage'));

settingsRoutes.get('/settings/menu', (c) => c.redirect('/admin/settings/system'));

settingsRoutes.get('/settings/system', async (c) => {
  const fallbackName = c.env.SITE_TITLE ?? '0xCMS';
  const [sidebarSettings, branding, pluginItems] = await Promise.all([
    loadSidebarChromeSettings(c.env),
    loadAppBrandingSettings(c.env, fallbackName),
    pluginNav(c.env),
  ]);
  const menuOption = (item: typeof SIDEBAR_MENU_ITEMS[number]) => ({
    value: item.key,
    label: item.label,
    description: item.description,
    checked: sidebarSettings.items[item.key].visible,
    locked: item.key === 'system',
    weight: sidebarSettings.items[item.key].weight,
  });
  const pluginOptions = pluginItems.map((item) => {
    const key = pluginSidebarKey(item);
    return {
      label: item.label,
      href: item.href,
      groupLabel: item.group === 'settings' ? 'Settings' : 'Main',
      key,
      formKey: encodeURIComponent(key),
      checked: !sidebarSettings.hiddenPluginKeys.has(key),
      weight: sidebarSettings.pluginWeights[key] ?? defaultPluginNavWeight(item.group),
    };
  });
  return renderPage(c, systemSettingsPage, {
    appName: branding.appName,
    appIcon: branding.appIcon,
    iconOptions: APP_ICON_OPTIONS.map((option) => ({
      ...option,
      selected: option.value === branding.appIcon,
    })),
    settingsGroupWeight: sidebarSettings.settingsGroupWeight,
    mainOptions: SIDEBAR_MENU_ITEMS.filter((item) => item.group === 'main').map(menuOption),
    settingsOptions: SIDEBAR_MENU_ITEMS.filter((item) => item.group === 'settings').map(menuOption),
    options: SIDEBAR_MENU_ITEMS.map(menuOption),
    pluginOptions,
    flash: c.req.query('flash') === 'saved' ? 'System settings saved' : '',
  });
});

settingsRoutes.post('/settings/menu', async (c) => c.redirect('/admin/settings/system', 303));

settingsRoutes.post('/settings/system', async (c) => {
  const form = await c.req.formData();
  const pluginItems = await pluginNav(c.env);
  const visibleKeys = form.getAll('visible_items').map(String);
  const weights = Object.fromEntries(SIDEBAR_MENU_ITEMS.map((item) => [item.key, form.get(`weight_${item.key}`)]));
  const pluginWeights = Object.fromEntries(pluginItems.map((item) => {
    const key = pluginSidebarKey(item);
    return [key, form.get(`plugin_weight_${encodeURIComponent(key)}`)];
  }));
  const pluginVisibleKeys = form.getAll('plugin_visible_items').map(String);
  await Promise.all([
    saveAppBrandingSettings(c.env, {
      appName: form.get('app_name'),
      appIcon: form.get('app_icon'),
    }, c.env.SITE_TITLE ?? '0xCMS'),
    saveSidebarMenuSettings(c.env, visibleKeys, weights, {
      settingsGroupWeight: form.get('settings_group_weight'),
      pluginWeights,
      pluginVisibleKeys,
    }),
  ]);
  logAudit(c, 'settings.system.update', 'settings', 'admin.system');
  return c.redirect('/admin/settings/system?flash=saved');
});
