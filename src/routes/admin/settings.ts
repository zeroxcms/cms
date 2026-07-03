import { Hono } from 'hono';
import { requirePermission } from '../../middleware/auth';
import { menuSettingsPage } from '../../templates/settings';
import type { Env, Variables } from '../../types';
import { logAudit } from '../../utils/audit';
import { renderPage } from '../../utils/admin-render';
import { SIDEBAR_MENU_ITEMS, loadSidebarMenuSettings, saveSidebarMenuSettings } from '../../utils/settings';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.use('/settings/menu', requirePermission('menu:manage'));

settingsRoutes.get('/settings/menu', async (c) => {
  const settings = await loadSidebarMenuSettings(c.env);
  return renderPage(c, menuSettingsPage, {
    options: SIDEBAR_MENU_ITEMS.map((item) => ({
      value: item.key,
      label: item.label,
      description: item.description,
      checked: settings[item.key],
    })),
    flash: c.req.query('flash') === 'saved' ? 'Menu settings saved' : '',
  });
});

settingsRoutes.post('/settings/menu', async (c) => {
  const form = await c.req.formData();
  const visibleKeys = form.getAll('visible_items').map(String);
  await saveSidebarMenuSettings(c.env, visibleKeys);
  logAudit(c, 'settings.menu.update', 'settings', 'admin.sidebar_menu');
  return c.redirect('/admin/settings/menu?flash=saved');
});
