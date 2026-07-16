import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { clearConfigCache, resolveCmsConfig } from '../src/plugins/config';
import {
  buildTranslationCatalog,
  deleteLocale,
  flattenMessages,
  listLocales,
  saveLocale,
  saveLocaleMessage,
} from '../src/utils/i18n';
import { APP_ICON_OPTIONS, SIDEBAR_MENU_ITEMS } from '../src/utils/settings';
import { USER_ROLES } from '../src/types';

const cmsEnv = env as unknown as Env;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM locale_messages WHERE locale_code = 'fr'").run();
  await env.DB.prepare("DELETE FROM locales WHERE code = 'fr'").run();
  clearConfigCache();
});

describe('database locale registry', () => {
  it('keeps mis as the protected unspecified content language', async () => {
    const locales = await listLocales(cmsEnv);
    const unspecified = locales.find((locale) => locale.code === 'mis');
    expect(unspecified).toMatchObject({ content_enabled: 1, ui_enabled: 0, builtin: 1 });
    await expect(deleteLocale(cmsEnv, 'mis')).rejects.toThrow('cannot be deleted');
  });

  it('extends the effective content languages from the database', async () => {
    await saveLocale(cmsEnv, {
      code: 'fr', label: 'Français', content_enabled: 'on', ui_enabled: 'on', fallback_code: 'en', weight: '40',
    });
    clearConfigCache();
    const config = await resolveCmsConfig(cmsEnv);
    expect(config.defaultLanguage).toBe('mis');
    expect(config.languages).toContain('fr');
  });

  it('merges bundled fallback strings with database overrides', async () => {
    await saveLocale(cmsEnv, {
      code: 'fr', label: 'Français', content_enabled: 'on', ui_enabled: 'on', fallback_code: 'en', weight: '40',
    });
    await saveLocaleMessage(cmsEnv, 'fr', 'common.save', 'Enregistrer');
    await saveLocaleMessage(cmsEnv, 'fr', 'plugin.demo.label', 'Extension démo');

    const catalog = await buildTranslationCatalog(cmsEnv, 'fr');
    expect(catalog['common.add']).toBe('Add');
    expect(catalog['common.save']).toBe('Enregistrer');
    expect(catalog['plugin.demo.label']).toBe('Extension démo');
  });

  it('keeps bundled locale files aligned with the English catalog', async () => {
    const catalogs = await Promise.all(['en', 'mis', 'zh-hans', 'zh-hant'].map(async (locale) => {
      const response = await cmsEnv.VIEWS.fetch(`https://views.local/locales/${locale}.json`);
      expect(response.ok).toBe(true);
      return flattenMessages(await response.json());
    }));
    const [english, unspecified, ...translated] = catalogs;
    const englishKeys = Object.keys(english).sort();

    expect(unspecified).toEqual(english);
    for (const catalog of translated) expect(Object.keys(catalog).sort()).toEqual(englishKeys);
  });

  it('defines every translation key used by core CMS views', async () => {
    const englishResponse = await cmsEnv.VIEWS.fetch('https://views.local/locales/en.json');
    const english = flattenMessages(await englishResponse.json());
    const viewPaths = [
      'layout/default.liquid',
      ...[
        'advanced-search', 'block-type-form', 'content-list', 'credit-summary', 'dashboard', 'editor', 'error',
        'languages', 'login', 'menu-settings', 'page-type-form', 'plugin-assets', 'plugin-credits', 'plugin-form',
        'plugin-limits', 'plugin-page-types', 'plugins-manage', 'profile', 'role-form', 'roles', 'tag-form', 'tags',
        'taxonomies', 'taxonomy-form', 'translations', 'trash', 'type-list', 'user-form', 'users',
      ].map((name) => `sections/${name}.liquid`),
      'snippets/color-tag-picker.liquid',
      'snippets/structured-editor.liquid',
      ...[
        'boolean/basic', 'checkbox/basic', 'color/basic', 'date/basic', 'date/datetime', 'date/range-tz',
        'email/basic', 'link/basic', 'number/basic', 'page/basic', 'picture/basic', 'radio/basic', 'richtext/md',
        'select/basic', 'switch/basic', 'tel/basic', 'text/basic', 'textarea/basic', 'time/basic', 'url/basic',
      ].map((name) => `snippets/pagefield/${name}.liquid`),
    ];
    const sources = await Promise.all(viewPaths.map(async (path) => {
      const response = await cmsEnv.VIEWS.fetch(`https://views.local/${path}`);
      expect(response.ok).toBe(true);
      return response.text();
    }));
    const usedKeys = sources.flatMap((source) => [
      ...source.matchAll(/["']([a-z0-9_.:-]+)["']\s*\|\s*t\b/gi),
    ].map((match) => match[1]));

    expect(usedKeys.length).toBeGreaterThan(0);
    expect(usedKeys.filter((key) => !(key in english))).toEqual([]);

    const generatedKeys = [
      ...APP_ICON_OPTIONS.map((option) => `settings.icons.${option.value}`),
      ...SIDEBAR_MENU_ITEMS.flatMap((item) => [`nav.${item.key}`, `settings.menu.${item.key}_description`]),
      ...['active', 'unreachable', 'disabled'].map((status) => `plugins.status.${status}`),
      ...['enable', 'disable'].map((action) => `plugins.actions.${action}`),
      ...USER_ROLES.map((role) => `roles.names.${role}`),
      ...['admin', 'builtin', 'custom'].map((type) => `roles.types.${type}`),
      ...['on_create', 'metered_per', 'free', 'credits', 'per_second', 'per_parent_page', 'per', 'total', 'unlimited']
        .map((key) => `credits.summary.${key}`),
    ];
    expect(generatedKeys.filter((key) => !(key in english))).toEqual([]);
  });

  it('rejects Liquid syntax in database messages', async () => {
    await expect(saveLocaleMessage(cmsEnv, 'en', 'unsafe.label', '{{ user.name }}')).rejects.toThrow('plain text');
  });
});
