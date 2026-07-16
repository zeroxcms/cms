import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { clearConfigCache, resolveCmsConfig } from '../src/plugins/config';
import {
  buildTranslationCatalog,
  deleteLocale,
  listLocales,
  saveLocale,
  saveLocaleMessage,
} from '../src/utils/i18n';

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

  it('rejects Liquid syntax in database messages', async () => {
    await expect(saveLocaleMessage(cmsEnv, 'en', 'unsafe.label', '{{ user.name }}')).rejects.toThrow('plain text');
  });
});
