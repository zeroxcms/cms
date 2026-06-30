// Form-data / query-string coercion helpers shared across the admin routes.
// Pure functions only — no DB or Hono context dependencies beyond structural typing.

import { cmsConfig } from '../cms-config';

// FormDataEntryValue is File | string in the Fetch API
export type FormValue = File | string | null | undefined;

export type CsvImportMode = 'new' | 'append' | 'new-append' | 'overwrite' | 'new-overwrite' | 'force-new';

export interface CsvImportModeOption {
  value: CsvImportMode;
  label: string;
  description: string;
  destructive: boolean;
}

export const CSV_IMPORT_MODE_OPTIONS: CsvImportModeOption[] = [
  {
    value: 'new-append',
    label: 'New + Add Missing Fields',
    description: 'Create new pages and fill empty fields or add tags on existing pages.',
    destructive: false,
  },
  {
    value: 'new',
    label: 'New Pages Only',
    description: 'Create only rows that do not match an existing draft page.',
    destructive: false,
  },
  {
    value: 'new-overwrite',
    label: 'New + Replace Existing Fields',
    description: 'Create new pages and replace matching fields on existing pages.',
    destructive: true,
  },
  {
    value: 'append',
    label: 'Existing Pages: Add Missing Fields',
    description: 'Only fill empty fields or add tags on existing pages.',
    destructive: false,
  },
  {
    value: 'overwrite',
    label: 'Existing Pages: Replace Fields',
    description: 'Only replace matching fields on existing pages.',
    destructive: true,
  },
  {
    value: 'force-new',
    label: 'Treat All Rows As New Pages',
    description: 'Create every CSV row as a new draft page, even when it matches an existing page.',
    destructive: false,
  },
];

export const DASHBOARD_DEFAULT_PAGE_SIZE = 100;
export const DASHBOARD_MAX_PAGE_SIZE = 100;
export type DashboardStatusFilter = '' | 'draft' | 'live';

export function str(v: FormValue): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function csvImportMode(v: FormValue): CsvImportMode {
  const value = str(v);
  return CSV_IMPORT_MODE_OPTIONS.some((option) => option.value === value)
    ? value as CsvImportMode
    : 'new-append';
}

export function csvImportModeOptions(selected: CsvImportMode = 'new-append') {
  return CSV_IMPORT_MODE_OPTIONS.map((option) => ({
    ...option,
    checked: option.value === selected,
  }));
}

export function strParam(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function nullableStr(v: FormValue): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

export function num(v: unknown, fallback = 5): number {
  const n = typeof v === 'number' ? v : parseInt(typeof v === 'string' ? v.trim() : String(v ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

export function dashboardPageSize(value: string | null | undefined): number {
  return Math.min(Math.max(num(value, DASHBOARD_DEFAULT_PAGE_SIZE), 1), DASHBOARD_MAX_PAGE_SIZE);
}

export function dashboardPageNumber(value: string | null | undefined): number {
  return Math.max(num(value, 1), 1);
}

export function dashboardStatusFilter(value: string | null | undefined): DashboardStatusFilter {
  return value === 'draft' || value === 'live' ? value : '';
}

export function dashboardPageHref(
  routeBase: string,
  page: number,
  pageSize: number,
  extraParams: Record<string, string | number | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pagesize', String(pageSize));
  for (const [key, value] of Object.entries(extraParams)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  return `${routeBase}?${params.toString()}`;
}

export function userIdFromContext(c: { get: (key: 'user') => { sub: string | number } }): number {
  return num(c.get('user').sub, 0);
}

export function editorsFromForm(form: FormData): string | null {
  const ids = str(form.get('editors'))
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
  return ids.length ? Array.from(new Set(ids)).join(',') : null;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function languageFromRequest(c: { req: { query: (name: string) => string | undefined } }, form?: FormData): string {
  const requested = str(form?.get('_language')) || c.req.query('language') || cmsConfig.defaultLanguage;
  return cmsConfig.languages.includes(requested) ? requested : cmsConfig.defaultLanguage;
}

export function safeAdminReturnPath(path: FormValue, fallback = '/admin'): string {
  const value = str(path);
  return value.startsWith('/admin') ? value : fallback;
}
