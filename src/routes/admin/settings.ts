import { Hono } from 'hono';
import { requirePermission } from '../../middleware/auth';
import { systemSettingsPage } from '../../templates/settings';
import { contentListPage, type ContentListMediaItem } from '../../templates/content-list';
import { creditSummaryPage, type CreditSummaryRow } from '../../templates/credit-summary';
import { languagesPage, translationsPage, type LocaleViewRow } from '../../templates/i18n';
import type { Env, Variables } from '../../types';
import { getPlugins, pluginNav } from '../../plugins/registry';
import { listPlugins } from '../../utils/plugin-store';
import { effectiveCreditsForPlugin, type EffectiveCredit } from '../../utils/credits';
import { logAudit } from '../../utils/audit';
import { renderPage } from '../../utils/admin-render';
import {
  APP_ICON_OPTIONS,
  SIDEBAR_MENU_ITEMS,
  defaultPluginNavWeight,
  loadAppBrandingSettings,
  loadAdminHomeSettings,
  loadSidebarChromeSettings,
  pluginSidebarKey,
  saveAdminHomeSettings,
  saveAppBrandingSettings,
  saveSidebarMenuSettings,
} from '../../utils/settings';
import {
  buildTranslationCatalog,
  deleteLocale,
  deleteLocaleMessage,
  listLocaleMessages,
  listLocales,
  normalizeLocaleCode,
  saveLocale,
  saveLocaleMessage,
} from '../../utils/i18n';
import { clearConfigCache } from '../../plugins/config';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.use('/settings/system', requirePermission('menu:manage'));
settingsRoutes.use('/settings/menu', requirePermission('menu:manage'));
settingsRoutes.use('/settings/content', requirePermission('menu:manage'));
settingsRoutes.use('/settings/credits', requirePermission('plugin:manage'));
settingsRoutes.use('/settings/languages', requirePermission('menu:manage'));
settingsRoutes.use('/settings/languages/*', requirePermission('menu:manage'));
settingsRoutes.use('/settings/translations', requirePermission('menu:manage'));
settingsRoutes.use('/settings/translations/*', requirePermission('menu:manage'));

const MEDIA_LIST_PAGE_SIZE = 50;

function message(value: string | undefined): string {
  return value ? value.slice(0, 300) : '';
}

settingsRoutes.get('/i18n/catalog/:locale', async (c) => {
  try {
    return c.json(await buildTranslationCatalog(c.env, c.req.param('locale')), 200, {
      'Cache-Control': 'private, no-cache',
    });
  } catch {
    return c.json({ error: 'Locale not found' }, 404);
  }
});

settingsRoutes.get('/settings/languages', async (c) => {
  const locales = await listLocales(c.env);
  const rows: LocaleViewRow[] = locales.map((locale) => ({
    code: locale.code,
    label: locale.label,
    contentEnabled: locale.content_enabled === 1,
    uiEnabled: locale.ui_enabled === 1,
    direction: locale.direction,
    fallbackCode: locale.fallback_code ?? '',
    weight: locale.weight,
    builtin: locale.builtin === 1,
    protected: locale.code === 'mis',
    updateAction: `/admin/settings/languages/${encodeURIComponent(locale.code)}`,
    deleteAction: `/admin/settings/languages/${encodeURIComponent(locale.code)}/delete`,
    translationsHref: `/admin/settings/translations?locale=${encodeURIComponent(locale.code)}`,
    fallbackOptions: locales.filter((option) => option.code !== locale.code).map((option) => ({
      code: option.code,
      label: `${option.label} (${option.code})`,
      selected: option.code === locale.fallback_code,
    })),
  }));
  return renderPage(c, languagesPage, {
    locales: rows,
    flash: message(c.req.query('flash')),
    error: message(c.req.query('error')),
  });
});

settingsRoutes.post('/settings/languages', async (c) => {
  const form = await c.req.formData();
  try {
    const code = await saveLocale(c.env, Object.fromEntries(form));
    clearConfigCache();
    logAudit(c, 'locale.create', 'locale', code);
    return c.redirect('/admin/settings/languages?flash=Language+added', 303);
  } catch (error) {
    return c.redirect(`/admin/settings/languages?error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to add language')}`, 303);
  }
});

settingsRoutes.post('/settings/languages/:code', async (c) => {
  const form = await c.req.formData();
  try {
    const code = await saveLocale(c.env, Object.fromEntries(form), c.req.param('code'));
    clearConfigCache();
    logAudit(c, 'locale.update', 'locale', code);
    return c.redirect('/admin/settings/languages?flash=Language+saved', 303);
  } catch (error) {
    return c.redirect(`/admin/settings/languages?error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to save language')}`, 303);
  }
});

settingsRoutes.post('/settings/languages/:code/delete', async (c) => {
  try {
    await deleteLocale(c.env, c.req.param('code'));
    clearConfigCache();
    logAudit(c, 'locale.delete', 'locale', c.req.param('code'));
    return c.redirect('/admin/settings/languages?flash=Language+deleted', 303);
  } catch (error) {
    return c.redirect(`/admin/settings/languages?error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to delete language')}`, 303);
  }
});

settingsRoutes.get('/settings/translations', async (c) => {
  const locales = await listLocales(c.env);
  const requested = c.req.query('locale') ?? 'en';
  const selected = locales.find((locale) => locale.code === requested) ?? locales.find((locale) => locale.code === 'en') ?? locales[0];
  if (!selected) return c.notFound();
  const messages = await listLocaleMessages(c.env, selected.code);
  return renderPage(c, translationsPage, {
    localeCode: selected.code,
    localeLabel: selected.label,
    localeOptions: locales.map((locale) => ({ code: locale.code, label: locale.label, selected: locale.code === selected.code })),
    messages: messages.map((entry) => ({
      key: entry.message_key,
      value: entry.value,
      deleteAction: `/admin/settings/translations/${encodeURIComponent(selected.code)}/${encodeURIComponent(entry.message_key)}/delete`,
    })),
    flash: message(c.req.query('flash')),
    error: message(c.req.query('error')),
  });
});

settingsRoutes.post('/settings/translations', async (c) => {
  const form = await c.req.formData();
  const locale = String(form.get('locale') ?? 'en');
  try {
    await saveLocaleMessage(c.env, locale, form.get('key'), form.get('value'), String(c.get('user').sub));
    logAudit(c, 'locale_message.upsert', 'locale', locale);
    return c.redirect(`/admin/settings/translations?locale=${encodeURIComponent(locale)}&flash=Translation+saved`, 303);
  } catch (error) {
    return c.redirect(`/admin/settings/translations?locale=${encodeURIComponent(locale)}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Unable to save translation')}`, 303);
  }
});

settingsRoutes.post('/settings/translations/:locale/:key/delete', async (c) => {
  const locale = normalizeLocaleCode(c.req.param('locale'));
  await deleteLocaleMessage(c.env, locale, c.req.param('key'));
  logAudit(c, 'locale_message.delete', 'locale', locale);
  return c.redirect(`/admin/settings/translations?locale=${encodeURIComponent(locale)}&flash=Translation+deleted`, 303);
});

function mediaHref(key: string): string {
  return `/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function pageReferencesMedia(lect: string | null, key: string): boolean {
  if (!lect) return false;
  const path = `/media/${key}`;
  const encodedPath = mediaHref(key);
  for (const candidate of new Set([path, encodedPath])) {
    let start = lect.indexOf(candidate);
    while (start !== -1) {
      const after = lect[start + candidate.length];
      if (!after || /[?#'"\s<>)\]}]/.test(after)) return true;
      start = lect.indexOf(candidate, start + candidate.length);
    }
  }
  return false;
}

async function linkedPagesForMedia(
  db: D1DatabaseClient,
  keys: string[],
): Promise<Map<string, ContentListMediaItem['linkedPages']>> {
  const links = new Map<string, ContentListMediaItem['linkedPages']>(keys.map((key) => [key, []]));
  if (!keys.length) return links;

  type PageRow = { id: number; name: string; slug: string; lect: string | null };
  // Scan each media-bearing page once, then match only the current R2 batch
  // in memory. A dynamically generated OR-of-LIKE expression can exceed
  // SQLite's complexity limit when the bucket page contains many objects.
  const pages = await db.prepare(
    "SELECT id, name, slug, lect FROM draft_pages WHERE instr(lect, '/media/') > 0 ORDER BY name ASC, id ASC",
  ).all<PageRow>();

  for (const page of pages.results) {
    for (const key of keys) {
      if (!pageReferencesMedia(page.lect, key)) continue;
      links.get(key)?.push({
        name: page.name,
        slug: page.slug,
        editHref: `/admin/pages/${page.id}/edit`,
      });
    }
  }
  return links;
}

settingsRoutes.get('/settings/menu', (c) => c.redirect('/admin/settings/system'));

settingsRoutes.get('/settings/content', async (c) => {
  if (!c.env.MEDIA_BUCKET) {
    return renderPage(c, contentListPage, { bucketConfigured: false, media: [], nextHref: '' });
  }

  const cursor = c.req.query('cursor') || undefined;
  const listed = await c.env.MEDIA_BUCKET.list({ limit: MEDIA_LIST_PAGE_SIZE, cursor });
  const keys = listed.objects.map((object) => object.key);
  const linkedPages = await linkedPagesForMedia(c.env.DB, keys);
  const media: ContentListMediaItem[] = listed.objects.map((object) => ({
    key: object.key,
    mediaHref: mediaHref(object.key),
    size: formatBytes(object.size),
    uploadedAt: object.uploaded.toISOString(),
    linkedPages: linkedPages.get(object.key) ?? [],
  }));
  const nextHref = listed.truncated && listed.cursor
    ? `/admin/settings/content?cursor=${encodeURIComponent(listed.cursor)}`
    : '';

  return renderPage(c, contentListPage, { bucketConfigured: true, media, nextHref });
});

function creditSummaryChargeLabel(credit: EffectiveCredit): string {
  return credit.def.charge === 'page_create'
    ? `On create: ${credit.def.pageType}`
    : `Metered per ${credit.def.unit}`;
}

settingsRoutes.get('/settings/credits', async (c) => {
  const [plugins, pluginRecords] = await Promise.all([
    getPlugins(c.env),
    listPlugins(c.env.DB),
  ]);
  const recordIds = new Map(pluginRecords.map((record) => [record.url, record.id]));
  const rows: CreditSummaryRow[] = (await Promise.all(plugins.map(async (plugin) => {
    const credits = await effectiveCreditsForPlugin(c.env, plugin);
    const pluginLabel = plugin.manifest.name || plugin.label || plugin.manifest.id;
    const pluginRecordId = recordIds.get(plugin.binding);
    return credits.map((credit) => ({
      pluginLabel,
      pluginId: plugin.manifest.id,
      key: credit.def.key,
      label: credit.def.label,
      description: credit.def.description,
      chargeLabel: creditSummaryChargeLabel(credit),
      effectiveLabel: credit.value === 0 ? 'Free' : `${credit.value} credits`,
      defaultLabel: credit.def.defaultValue === 0 ? 'Free' : `${credit.def.defaultValue} credits`,
      sourceLabel: credit.configured ? 'Admin override' : 'Plugin default',
      manageHref: pluginRecordId
        ? `/admin/plugins-manage/${pluginRecordId}/credits`
        : '/admin/plugins-manage',
    }));
  }))).flat().sort((a, b) => (
    a.pluginLabel.localeCompare(b.pluginLabel)
      || a.label.localeCompare(b.label)
      || a.key.localeCompare(b.key)
  ));
  const pluginCount = new Set(rows.map((row) => row.pluginId)).size;
  const paidCount = rows.filter((row) => row.effectiveLabel !== 'Free').length;

  return renderPage(c, creditSummaryPage, {
    rows,
    pluginCount,
    chargeCount: rows.length,
    paidCount,
  });
});

settingsRoutes.get('/settings/system', async (c) => {
  const fallbackName = c.env.SITE_TITLE ?? '0xCMS';
  const [sidebarSettings, branding, adminHome, pluginItems] = await Promise.all([
    loadSidebarChromeSettings(c.env),
    loadAppBrandingSettings(c.env, fallbackName),
    loadAdminHomeSettings(c.env),
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
    adminHomePath: adminHome.href,
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
    saveAdminHomeSettings(c.env, {
      href: form.get('admin_home_path'),
    }),
    saveSidebarMenuSettings(c.env, visibleKeys, weights, {
      settingsGroupWeight: form.get('settings_group_weight'),
      pluginWeights,
      pluginVisibleKeys,
    }),
  ]);
  logAudit(c, 'settings.system.update', 'settings', 'admin.system');
  return c.redirect('/admin/settings/system?flash=saved');
});
