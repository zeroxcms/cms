import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface LocaleViewRow {
  code: string;
  label: string;
  contentEnabled: boolean;
  uiEnabled: boolean;
  direction: string;
  fallbackCode: string;
  weight: number;
  builtin: boolean;
  protected: boolean;
  updateAction: string;
  deleteAction: string;
  translationsHref: string;
  fallbackOptions: Array<{ code: string; label: string; selected: boolean }>;
}

export async function languagesPage(views: Fetcher, opts: BaseTemplateProps & {
  locales: LocaleViewRow[];
  flash?: string;
  error?: string;
}): Promise<string> {
  const body = await renderView(views, '/templates/languages.json', {
    locales: opts.locales,
    hasLocales: opts.locales.length > 0,
    flash: opts.flash ?? '',
    error: opts.error ?? '',
    hasFlash: !!opts.flash,
    hasError: !!opts.error,
  });
  return adminLayout(views, opts, { title: 'Languages', body });
}

export async function translationsPage(views: Fetcher, opts: BaseTemplateProps & {
  localeCode: string;
  localeLabel: string;
  localeOptions: Array<{ code: string; label: string; selected: boolean }>;
  messages: Array<{ key: string; value: string; deleteAction: string }>;
  flash?: string;
  error?: string;
}): Promise<string> {
  const body = await renderView(views, '/templates/translations.json', {
    localeCode: opts.localeCode,
    localeLabel: opts.localeLabel,
    localeOptions: opts.localeOptions,
    messages: opts.messages,
    hasMessages: opts.messages.length > 0,
    flash: opts.flash ?? '',
    error: opts.error ?? '',
    hasFlash: !!opts.flash,
    hasError: !!opts.error,
  });
  return adminLayout(views, opts, { title: 'Translations', body });
}
