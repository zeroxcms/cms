// ============================================================
// Admin routes (all protected by authMiddleware + editorGuard)
//
//   GET  /admin                         – dashboard (draft pages)
//   GET  /admin/pages/new               – new page form
//   POST /admin/pages                   – create page
//   GET  /admin/pages/:id/edit          – edit page form
//   POST /admin/pages/:id               – update page
//   POST /admin/pages/:id/publish       – publish draft → live
//   POST /admin/pages/:id/unpublish     – unpublish from live
//   POST /admin/pages/:id/delete        – soft-delete to trash (unpublishes too)
//   GET  /admin/trash                   – list trashed pages
//   POST /admin/trash/:id/restore       – restore page from trash → draft
//   POST /admin/trash/:id/delete        – permanently delete from trash
//   GET  /admin/tags                    – tag list and editor
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { authMiddleware, editorGuard } from '../middleware/auth';
import { advancedSearchPage } from '../templates/advanced-search';
import { dashboardPage } from '../templates/dashboard';
import { editorPage } from '../templates/editor';
import { importPage } from '../templates/import';
import { tagTypeFormPage, tagTypesPage } from '../templates/tag-types';
import { tagFormPage, tagsPage } from '../templates/tags';
import { trashPage } from '../templates/trash';
import { cmsConfig } from '../cms-config';
import type { BlueprintEntry } from '../cms-config';
import {
  blockToLect,
  blueprintToLect,
  defaultLectItem,
  getBlueprintProps,
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  mergeLects,
  normalizeLect,
  postToLect,
  safeParseLect,
  stringifyLect,
} from '../utils/lect';
import type { Env, Variables, Page, PageVersion, PageTag, Tag, TagType } from '../types';
import type { Lect, LectItem } from '../utils/lect';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type AdminContext = Context<{ Bindings: Env; Variables: Variables }>;
type AdvancedSearchOperator = 'AND' | 'OR' | 'NOT';

interface AdvancedSearchCriterion {
  index: number;
  term: string;
  path: string;
  tags: string[];
}

interface AdvancedSearchResult {
  results: Page[];
  pagination: {
    total: number;
    totalPages: number;
    currentPage: number;
    limit: number;
  };
}

type BlueprintPathKind = 'scalar' | 'localized' | 'pointer';

interface BlueprintPathSpec {
  path: string;
  kind: BlueprintPathKind;
}

interface CsvImportResult {
  created: number;
  updated: number;
  skipped: number;
}

// Apply auth to all admin routes
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', editorGuard);

// ── Helper: parse form data safely ────────────────────────────────────────────

// FormDataEntryValue is File | string in the Fetch API
type FormValue = File | string | null | undefined;

function str(v: FormValue): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strParam(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function nullableStr(v: FormValue): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

function num(v: unknown, fallback = 5): number {
  const n = typeof v === 'number' ? v : parseInt(typeof v === 'string' ? v.trim() : String(v ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

function userIdFromContext(c: AdminContext): number {
  return num(c.get('user').sub, 0);
}

function withDraftMetadata(lect: Lect, modifier: number): Lect {
  return {
    ...normalizeLect(lect),
    _modifier: modifier,
    _updated_at: new Date().toISOString(),
  };
}

function editorsFromForm(form: FormData): string | null {
  const ids = str(form.get('editors'))
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
  return ids.length ? Array.from(new Set(ids)).join(',') : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function languageFromRequest(c: { req: { query: (name: string) => string | undefined } }, form?: FormData): string {
  const requested = str(form?.get('_language')) || c.req.query('language') || cmsConfig.defaultLanguage;
  return cmsConfig.languages.includes(requested) ? requested : cmsConfig.defaultLanguage;
}

function blueprintPropsFor(pageType: string) {
  return getBlueprintProps(cmsConfig.blueprint[pageType] ?? cmsConfig.blueprint.default);
}

function blockPropsByName(): Record<string, ReturnType<typeof getBlueprintProps>> {
  const props: Record<string, ReturnType<typeof getBlueprintProps>> = {};
  for (const [name, blueprint] of Object.entries(cmsConfig.blocks)) {
    props[name] = getBlueprintProps(blueprint);
  }
  return props;
}

function lectsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if ((left ?? '') === (right ?? '')) return true;
  return stringifyLect(safeParseLect(left)) === stringifyLect(safeParseLect(right));
}

async function editorTaxonomy(db: D1Database): Promise<{ tags: Tag[]; tagTypes: TagType[] }> {
  const [tags, tagTypes] = await Promise.all([
    db.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    db.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
  ]);
  return {
    tags: tags.results,
    tagTypes: tagTypes.results,
  };
}

function parseAdvancedSearchCriteria(url: string): AdvancedSearchCriterion[] {
  const params = new URL(url).searchParams;
  const criteria: AdvancedSearchCriterion[] = [];
  const indexes = new Set<number>();

  for (const key of params.keys()) {
    const match = key.match(/^(?:search|path|tags)(\d+)$/);
    if (match) indexes.add(parseInt(match[1], 10));
  }

  for (const index of [...indexes].sort((left, right) => left - right)) {
    const term = strParam(params.get(`search${index}`));
    const path = strParam(params.get(`path${index}`));
    const tags = params.getAll(`tags${index}`)
      .flatMap((value) => value.split(','))
      .map((tag) => tag.trim())
      .filter((tag) => /^\d+$/.test(tag));

    if (term || tags.length) {
      criteria.push({
        index,
        term,
        path,
        tags: Array.from(new Set(tags)),
      });
    }
  }

  return criteria;
}

function advancedSearchOperator(value: string | null | undefined): AdvancedSearchOperator {
  const operator = strParam(value).toUpperCase();
  return operator === 'OR' || operator === 'NOT' ? operator : 'AND';
}

function advancedSearchPageSize(value: string | null | undefined): number {
  return Math.min(Math.max(num(value, 20), 1), 100);
}

function advancedSearchSort(value: string | null | undefined): string {
  const sort = strParam(value);
  return ['id', 'name', 'slug', 'weight', 'created_at', 'updated_at'].includes(sort) ? sort : 'updated_at';
}

function advancedSearchOrder(value: string | null | undefined): 'ASC' | 'DESC' {
  return strParam(value).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

function advancedSearchQueryString(
  criteria: AdvancedSearchCriterion[],
  operator: AdvancedSearchOperator,
  pageSize: number,
  extras: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  params.set('operator', operator);
  params.set('pagesize', String(pageSize));

  for (const criterion of criteria) {
    params.set(`search${criterion.index}`, criterion.term);
    params.set(`path${criterion.index}`, criterion.path);
    for (const tag of criterion.tags) params.append(`tags${criterion.index}`, tag);
  }

  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined && String(value) !== '') params.set(key, String(value));
  }

  return params.toString();
}

function advancedSearchPageTypes(): string[] {
  return Object.keys(cmsConfig.blueprint);
}

function advancedSearchSelectedPageType(value: string | null | undefined, fallback = 'all'): string {
  const pageTypes = advancedSearchPageTypes();
  const requested = strParam(value || fallback);
  return pageTypes.includes(requested) ? requested : 'all';
}

function advancedSearchTargetPageTypes(selectedPageType: string): string[] {
  const pageTypes = advancedSearchPageTypes();
  return selectedPageType === 'all' ? pageTypes : [selectedPageType];
}

function blueprintFieldPath(raw: string, prefix = ''): string {
  return raw.replace(prefix, '').split(':')[0].split('__').filter(Boolean).join('.');
}

function childPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function collectBlueprintPathSpecs(entries: BlueprintEntry[], parentPath = ''): BlueprintPathSpec[] {
  const specs: BlueprintPathSpec[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) {
        specs.push({ path: childPath(parentPath, blueprintFieldPath(entry, '@')), kind: 'scalar' });
      } else if (entry.startsWith('*')) {
        specs.push({ path: childPath(parentPath, `_pointers.${blueprintFieldPath(entry, '*')}`), kind: 'pointer' });
      } else {
        specs.push({ path: childPath(parentPath, blueprintFieldPath(entry)), kind: 'localized' });
      }
      continue;
    }

    for (const [itemName, definitions] of Object.entries(entry)) {
      const itemPath = childPath(parentPath, `${itemName}[*]`);
      specs.push(...collectBlueprintPathSpecs(definitions, itemPath));
    }
  }

  return specs;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function advancedSearchPathSpecs(pageTypes: string[]): BlueprintPathSpec[] {
  const specs = pageTypes.flatMap((pageType) => collectBlueprintPathSpecs(cmsConfig.blueprint[pageType] ?? []));
  const byPath = new Map<string, BlueprintPathSpec>();
  for (const spec of specs) byPath.set(spec.path, spec);
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function advancedSearchPathOptions(pageTypes: string[]): string[] {
  return advancedSearchPathSpecs(pageTypes).map((spec) => spec.path);
}

function advancedSearchPathKindMap(pageTypes: string[]): Map<string, BlueprintPathKind> {
  return new Map(advancedSearchPathSpecs(pageTypes).map((spec) => [spec.path, spec.kind]));
}

function advancedSearchPathOptionsByPageType(): Record<string, string[]> {
  const pageTypeOptions = Object.fromEntries(
    advancedSearchPageTypes().map((pageType) => [pageType, advancedSearchPathOptions([pageType])]),
  );
  return {
    all: uniqueSorted(Object.values(pageTypeOptions).flat()),
    ...pageTypeOptions,
  };
}

function wildcardJsonPathParts(path: string): { beforePath: string; afterPath: string } | null {
  const wildcardMatch = path.match(/(.+?)\[\*\](.+)/i);
  if (!wildcardMatch) return null;

  return {
    beforePath: wildcardMatch[1].replace(/^\./, ''),
    afterPath: wildcardMatch[2].replace(/^\./, ''),
  };
}

function sqliteJsonPath(path: string): string {
  const normalized = path.replace(/^\$?\.?/, '');
  if (!normalized) return '$';

  return `$${normalized.split('.').filter(Boolean).map((segment) => {
    const match = segment.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[\d+])?$/);
    if (match) return `.${match[1]}${match[2] ?? ''}`;
    return `.${JSON.stringify(segment)}`;
  }).join('')}`;
}

function csvFormatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  const escaped = text.replace(/"/g, '""');
  if (/[",\r\n]/.test(text)) return `"${escaped}"`;
  if (/^[\d\s\-+()]+$/.test(text) && /\d/.test(text)) return `="${escaped}"`;
  return escaped;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(normalizeCsvCell(cell));
      cell = '';
    } else if (char === '\n') {
      row.push(normalizeCsvCell(cell));
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(normalizeCsvCell(cell));
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

function normalizeCsvCell(value: string): string {
  const trimmed = value.trim();
  const formulaMatch = trimmed.match(/^="(.*)"$/);
  return formulaMatch ? formulaMatch[1].replace(/""/g, '"') : trimmed;
}

function csvRowsToObjects(rows: string[][]): Array<Record<string, string>> {
  const [headers = [], ...dataRows] = rows;
  return dataRows.map((row) => Object.fromEntries(headers.map((header, index) => [
    header.trim().replace(/^\uFEFF/, ''),
    row[index] ?? '',
  ])));
}

function splitListValue(value: string): string[] {
  return value.split(';').map((entry) => entry.trim()).filter(Boolean);
}

function lectValueToCsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(lectValueToCsvCell).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const defaultValue = record[cmsConfig.defaultLanguage];
    if (defaultValue !== undefined) return lectValueToCsvCell(defaultValue);
    const firstScalar = Object.values(record).find((entry) => (
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
    ));
    if (firstScalar !== undefined) return String(firstScalar);
    return JSON.stringify(record);
  }
  return String(value);
}

function getLectValueByPath(lect: Lect, path: string): string {
  const wildcardMatch = path.match(/^(.+?)\[\*\]\.(.+)$/);
  if (wildcardMatch) {
    const items = getPathValue(lect, wildcardMatch[1]);
    if (!Array.isArray(items)) return '';
    return items.map((item) => getLectValueByPath(item as Lect, wildcardMatch[2])).filter(Boolean).join('; ');
  }

  return lectValueToCsvCell(getPathValue(lect, path));
}

function getPathValue(source: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current = source as Record<string, unknown> | undefined;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[segment] as Record<string, unknown> | undefined;
  }
  return current;
}

function ensureRecordPath(source: Record<string, unknown>, path: string): Record<string, unknown> {
  const segments = path.split('.').filter(Boolean);
  let current = source;
  for (const segment of segments) {
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

function setLectPathValue(lect: Lect, path: string, kind: BlueprintPathKind, value: string): void {
  const wildcardMatch = path.match(/^(.+?)\[\*\]\.(.+)$/);
  if (wildcardMatch) {
    const [itemName, childPath] = [wildcardMatch[1], wildcardMatch[2]];
    const values = splitListValue(value);
    if (!Array.isArray(lect[itemName])) lect[itemName] = [];
    const items = lect[itemName] as LectItem[];
    values.forEach((entry, index) => {
      items[index] ||= {};
      setLectPathValue(items[index], childPath, kind, entry);
    });
    return;
  }

  if (kind === 'pointer') {
    const pointerPath = path.replace(/^_pointers\.?/, '');
    lect._pointers ||= {};
    lect._pointers[pointerPath] = value;
    return;
  }

  const segments = path.split('.').filter(Boolean);
  const field = segments.pop();
  if (!field) return;
  const target = ensureRecordPath(lect as Record<string, unknown>, segments.join('.'));
  target[field] = kind === 'localized' ? { [cmsConfig.defaultLanguage]: value } : value;
}

function exportHeaders(pageTypes: string[], tagTypes: TagType[]): string[] {
  return [
    'id',
    'uuid',
    'name',
    'slug',
    'weight',
    'start',
    'end',
    'page_type',
    ...advancedSearchPathOptions(pageTypes),
    ...tagTypes.map((tagType) => `tag:${tagType.name}`),
  ];
}

async function pageTagsForExport(db: D1Database): Promise<Map<number, Record<string, string[]>>> {
  const rows = await db.prepare(
    `SELECT dpt.page_id, t.name as tag_name, tt.name as tag_type_name
     FROM draft_page_tags dpt
     JOIN tags t ON t.id = dpt.tag_id
     LEFT JOIN tag_types tt ON tt.id = t.tag_type_id`,
  ).all<{ page_id: number; tag_name: string; tag_type_name: string | null }>();
  const result = new Map<number, Record<string, string[]>>();
  for (const row of rows.results) {
    if (!row.tag_type_name) continue;
    const pageTags = result.get(row.page_id) ?? {};
    pageTags[row.tag_type_name] ||= [];
    pageTags[row.tag_type_name].push(row.tag_name);
    result.set(row.page_id, pageTags);
  }
  return result;
}

async function exportPagesCsv(db: D1Database, pages: Page[], pageTypes: string[]): Promise<string> {
  const taxonomy = await editorTaxonomy(db);
  const headers = exportHeaders(pageTypes, taxonomy.tagTypes);
  const pathColumns = advancedSearchPathOptions(pageTypes);
  const tagsByPage = await pageTagsForExport(db);
  const rows = [headers];

  for (const page of pages) {
    const lect = lectForPage(page.page_type ?? 'default', page.lect);
    const tagGroups = tagsByPage.get(page.id) ?? {};
    rows.push([
      String(page.id),
      page.uuid,
      page.name,
      page.slug,
      String(page.weight ?? ''),
      page.start ?? '',
      page.end ?? '',
      page.page_type ?? '',
      ...pathColumns.map((path) => getLectValueByPath(lect, path)),
      ...taxonomy.tagTypes.map((tagType) => (tagGroups[tagType.name] ?? []).join('; ')),
    ]);
  }

  return `\uFEFF${rows.map((row) => row.map(csvFormatValue).join(',')).join('\n')}`;
}

async function readImportCsvText(form: FormData): Promise<string> {
  const file = form.get('file') as unknown;
  if (file && typeof file === 'object' && 'text' in file && 'size' in file) {
    const upload = file as { size: number; text: () => Promise<string> };
    if (upload.size > 0) return upload.text();
  }
  return str(form.get('csv'));
}

async function findImportTarget(db: D1Database, pageType: string, row: Record<string, string>): Promise<Page | null> {
  const id = row.id?.trim();
  if (id) {
    const page = await db.prepare('SELECT * FROM draft_pages WHERE id = ? AND page_type = ?')
      .bind(id, pageType)
      .first<Page>();
    if (page) return page;
  }

  const slug = row.slug?.trim();
  if (!slug) return null;
  return db.prepare('SELECT * FROM draft_pages WHERE slug = ? AND page_type = ?')
    .bind(slug, pageType)
    .first<Page>();
}

async function uniqueTagSlug(db: D1Database, baseSlug: string): Promise<string> {
  let slug = baseSlug || 'tag';
  let suffix = 1;
  while (await db.prepare('SELECT id FROM tags WHERE slug = ?').bind(slug).first<{ id: number }>()) {
    suffix++;
    slug = `${baseSlug}-${suffix}`;
  }
  return slug;
}

async function ensureTag(db: D1Database, tagType: TagType, name: string): Promise<number> {
  const existing = await db.prepare('SELECT id FROM tags WHERE tag_type_id = ? AND name = ?')
    .bind(tagType.id, name)
    .first<{ id: number }>();
  if (existing) return existing.id;

  const slug = await uniqueTagSlug(db, slugify(`${tagType.slug || tagType.name}-${name}`));
  const insert = await db.prepare('INSERT INTO tags (name, slug, tag_type_id) VALUES (?, ?, ?)')
    .bind(name, slug, tagType.id)
    .run();
  const tag = await db.prepare('SELECT id FROM tags WHERE rowid = ?')
    .bind(insert.meta.last_row_id)
    .first<{ id: number }>();
  return tag!.id;
}

async function importPageTags(db: D1Database, pageId: number, row: Record<string, string>, tagTypes: TagType[]): Promise<void> {
  for (const tagType of tagTypes) {
    const header = `tag:${tagType.name}`;
    const value = row[header] ?? row[tagType.name];
    if (value === undefined) continue;

    await db.prepare(
      `DELETE FROM draft_page_tags
       WHERE page_id = ? AND tag_id IN (SELECT id FROM tags WHERE tag_type_id = ?)`,
    )
      .bind(pageId, tagType.id)
      .run();

    for (const tagName of splitListValue(value)) {
      const tagId = await ensureTag(db, tagType, tagName);
      const existing = await db.prepare('SELECT id FROM draft_page_tags WHERE page_id = ? AND tag_id = ?')
        .bind(pageId, tagId)
        .first<{ id: number }>();
      if (existing) continue;
      await db.prepare('INSERT INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
        .bind(pageId, tagId)
        .run();
    }
  }
}

async function importPagesCsv(db: D1Database, pageType: string, csvText: string, userId: number): Promise<CsvImportResult> {
  const rows = csvRowsToObjects(parseCsv(csvText));
  const pathKinds = advancedSearchPathKindMap([pageType]);
  const taxonomy = await editorTaxonomy(db);
  const result: CsvImportResult = { created: 0, updated: 0, skipped: 0 };

  for (const row of rows) {
    const existing = await findImportTarget(db, pageType, row);
    const baseLect = existing ? lectForPage(pageType, existing.lect) : blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage);
    const lect = normalizeLect(baseLect);

    for (const [path, kind] of pathKinds) {
      if (!(path in row)) continue;
      setLectPathValue(lect, path, kind, row[path] ?? '');
    }

    lect._type = pageType;
    const name = row.name?.trim() || getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || existing?.name || `Untitled ${pageType}`;
    const slug = row.slug?.trim() || existing?.slug || slugify(name);
    const lectValue = stringifyLect(withDraftMetadata(lect, userId));
    const weight = row.weight ? num(row.weight) : existing?.weight ?? 5;
    const start = row.start?.trim() || existing?.start || null;
    const end = row.end?.trim() || existing?.end || null;

    if (existing) {
      await db.prepare(
        `UPDATE draft_pages SET name = ?, slug = ?, weight = ?, start = ?, end = ?, lect = ? WHERE id = ?`,
      )
        .bind(name, slug, weight, start, end, lectValue, existing.id)
        .run();
      const versionId = await savePageVersion(db, existing.id, lectValue, 'import');
      await db.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
        .bind(versionId, existing.id)
        .run();
      await importPageTags(db, existing.id, row, taxonomy.tagTypes);
      result.updated++;
      continue;
    }

    const insert = await db.prepare(
      `INSERT INTO draft_pages (name, slug, weight, start, end, page_type, lect, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(name, slug, weight, start, end, pageType, lectValue, userId || null)
      .run();
    const page = await db.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
      .bind(insert.meta.last_row_id)
      .first<{ id: number }>();
    if (!page) {
      result.skipped++;
      continue;
    }
    const versionId = await savePageVersion(db, page.id, lectValue, 'import');
    await db.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
      .bind(versionId, page.id)
      .run();
    await importPageTags(db, page.id, row, taxonomy.tagTypes);
    result.created++;
  }

  return result;
}

async function exportAdvancedSearch(c: AdminContext, defaultPageType = 'all', canSelectPageType = true): Promise<Response> {
  const criteria = parseAdvancedSearchCriteria(c.req.url);
  const selectedPageType = canSelectPageType
    ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType)
    : advancedSearchSelectedPageType(undefined, defaultPageType);
  const pageTypes = advancedSearchTargetPageTypes(selectedPageType);
  const operator = advancedSearchOperator(c.req.query('operator'));
  const sort = advancedSearchSort(c.req.query('sort'));
  const order = advancedSearchOrder(c.req.query('order'));
  const result = criteria.length
    ? await performAdvancedSearch(c.env.DB, pageTypes, criteria, operator, {
        limit: 10000,
        page: 1,
        sort,
        order,
      })
    : {
        results: [],
        pagination: {
          total: 0,
          totalPages: 1,
          currentPage: 1,
          limit: 10000,
        },
      };
  const csv = await exportPagesCsv(c.env.DB, result.results, pageTypes);
  const stamp = c.req.query('r') || new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${selectedPageType === 'all' ? 'pages' : selectedPageType}-export-${stamp}.csv`;

  return new Response(csv, {
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': 'text/csv; charset=utf-8',
      'Expires': '0',
      'Pragma': 'no-cache',
    },
  });
}

function advancedSearchCondition(
  criterion: AdvancedSearchCriterion,
  pageAlias: string,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (criterion.term) {
    const searchTerm = `%${criterion.term.replaceAll(' ', '%')}%`;
    if (criterion.path) {
      const wildcardParts = wildcardJsonPathParts(criterion.path);
      if (wildcardParts) {
        conditions.push(`EXISTS (
          SELECT 1 FROM json_each(json_extract(${pageAlias}.lect, ?))
          WHERE json_extract(value, ?) LIKE ?
        )`);
        params.push(sqliteJsonPath(wildcardParts.beforePath), sqliteJsonPath(wildcardParts.afterPath), searchTerm);
      } else {
        conditions.push(`json_extract(${pageAlias}.lect, ?) LIKE ?`);
        params.push(sqliteJsonPath(criterion.path), searchTerm);
      }
    } else {
      conditions.push(`${pageAlias}.lect LIKE ?`);
      params.push(searchTerm);
    }
  }

  if (criterion.tags.length > 0) {
    const placeholders = criterion.tags.map(() => '?').join(',');
    conditions.push(`${pageAlias}.id IN (
      SELECT page_id FROM draft_page_tags
      WHERE tag_id IN (${placeholders})
      GROUP BY page_id
      HAVING COUNT(DISTINCT tag_id) = ?
    )`);
    params.push(...criterion.tags, criterion.tags.length);
  }

  return { conditions, params };
}

async function performAdvancedSearch(
  db: D1Database,
  pageTypes: string[],
  criteria: AdvancedSearchCriterion[],
  operator: AdvancedSearchOperator,
  options: {
    limit: number;
    page: number;
    sort: string;
    order: 'ASC' | 'DESC';
  },
): Promise<AdvancedSearchResult> {
  let searchCondition = '1=0';
  let searchParams: unknown[] = [];
  const pageTypePlaceholders = pageTypes.map(() => '?').join(',');

  if (criteria.length > 0 && operator === 'NOT') {
    const base = advancedSearchCondition(criteria[0], 'p');
    const baseCondition = base.conditions.length ? `(${base.conditions.join(' AND ')})` : '1=1';
    const excludeConditions: string[] = [];
    const excludeParams: unknown[] = [];

    for (const criterion of criteria.slice(1)) {
      const exclusion = advancedSearchCondition(criterion, 'excluded');
      if (!exclusion.conditions.length) continue;
      excludeConditions.push(`(${exclusion.conditions.join(' AND ')})`);
      excludeParams.push(...exclusion.params);
    }

    searchCondition = baseCondition;
    searchParams = base.params;
    if (excludeConditions.length) {
      searchCondition += ` AND p.id NOT IN (
        SELECT excluded.id FROM draft_pages excluded
        WHERE excluded.page_type IN (${pageTypePlaceholders}) AND (${excludeConditions.join(' OR ')})
      )`;
      searchParams.push(...pageTypes, ...excludeParams);
    }
  } else if (criteria.length > 0) {
    const criterionConditions: string[] = [];
    for (const criterion of criteria) {
      const condition = advancedSearchCondition(criterion, 'p');
      if (!condition.conditions.length) continue;
      criterionConditions.push(`(${condition.conditions.join(' AND ')})`);
      searchParams.push(...condition.params);
    }
    searchCondition = criterionConditions.length ? `(${criterionConditions.join(` ${operator} `)})` : '1=0';
  }

  const whereSql = `p.page_type IN (${pageTypePlaceholders}) AND ${searchCondition}`;
  const baseParams = [...pageTypes, ...searchParams];
  const countRow = await db.prepare(`SELECT COUNT(*) as total FROM draft_pages p WHERE ${whereSql}`)
    .bind(...baseParams)
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / options.limit));
  const currentPage = Math.min(options.page, totalPages);
  const currentOffset = (currentPage - 1) * options.limit;

  const pages = await db.prepare(
    `SELECT * FROM draft_pages p
     WHERE ${whereSql}
     ORDER BY ${options.sort} ${options.order}, id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...baseParams, options.limit, currentOffset)
    .all<Page>();

  return {
    results: pages.results,
    pagination: {
      total,
      totalPages,
      currentPage,
      limit: options.limit,
    },
  };
}

function advancedSearchFormCriteria(criteria: AdvancedSearchCriterion[], tagTypes: TagType[], tags: Tag[]) {
  const formCriteria = criteria.length ? criteria : [{ index: 1, term: '', path: '', tags: [] }];

  return formCriteria.map((criterion) => ({
    ...criterion,
    tagGroups: tagTypes.map((tagType) => ({
      name: tagType.name,
      tags: tags
        .filter((tag) => tag.tag_type_id === tagType.id)
        .map((tag) => ({
          id: tag.id,
          idString: String(tag.id),
          name: tag.name,
          selected: criterion.tags.includes(String(tag.id)),
        })),
    })).filter((group) => group.tags.length > 0),
  }));
}

function advancedSearchTagGroups(tagTypes: TagType[], tags: Tag[]) {
  return tagTypes.map((tagType) => ({
    name: tagType.name,
    tags: tags
      .filter((tag) => tag.tag_type_id === tagType.id)
      .map((tag) => ({
        id: tag.id,
        idString: String(tag.id),
        name: tag.name,
      })),
  })).filter((group) => group.tags.length > 0);
}

async function renderAdvancedSearch(c: AdminContext, defaultPageType = 'all', canSelectPageType = true) {
  const user = c.get('user');
  const criteria = parseAdvancedSearchCriteria(c.req.url);
  const selectedPageType = canSelectPageType
    ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType)
    : advancedSearchSelectedPageType(undefined, defaultPageType);
  const pageTypes = advancedSearchTargetPageTypes(selectedPageType);
  const operator = advancedSearchOperator(c.req.query('operator'));
  const pageSize = advancedSearchPageSize(c.req.query('pagesize'));
  const requestedPage = Math.max(num(c.req.query('page'), 1), 1);
  const sort = advancedSearchSort(c.req.query('sort'));
  const order = advancedSearchOrder(c.req.query('order'));
  const hasSearch = criteria.length > 0;

  const [taxonomy, dbUser] = await Promise.all([
    editorTaxonomy(c.env.DB),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  const result = hasSearch
    ? await performAdvancedSearch(c.env.DB, pageTypes, criteria, operator, {
        limit: pageSize,
        page: requestedPage,
        sort,
        order,
      })
    : {
        results: [],
        pagination: {
          total: 0,
          totalPages: 1,
          currentPage: requestedPage,
          limit: pageSize,
        },
      };

  const pageTypePlaceholders = pageTypes.map(() => '?').join(',');
  const livePages = await c.env.DB.prepare(`SELECT uuid, lect, weight FROM live_pages WHERE page_type IN (${pageTypePlaceholders})`)
    .bind(...pageTypes)
    .all<{ uuid: string; lect: string | null; weight: number }>();
  const liveMap = new Map(livePages.results.map((page) => [page.uuid, page]));
  const routeBase = selectedPageType === 'all'
    ? '/admin/advanced-search'
    : `/admin/advanced-search/${encodeURIComponent(selectedPageType)}`;
  const exportBase = selectedPageType === 'all'
    ? '/admin/advanced-search-export'
    : `/admin/advanced-search-export/${encodeURIComponent(selectedPageType)}`;
  const queryWithoutPage = advancedSearchQueryString(criteria, operator, pageSize, { sort, order });
  const pageQuery = (page: number) => advancedSearchQueryString(criteria, operator, pageSize, {
    sort,
    order,
    page,
  });
  const maxCriterionIndex = criteria.reduce((max, criterion) => Math.max(max, criterion.index), 0);
  const pathOptionsByPageType = advancedSearchPathOptionsByPageType();

  return c.html(
    await advancedSearchPage(c.env.VIEWS, {
      siteTitle: `${c.env.SITE_TITLE ?? 'Worker CMS'} · Advanced Search`,
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      pageTitle: selectedPageType === 'all' ? 'Advanced Search' : `Advanced Search: ${selectedPageType}`,
      pageType: selectedPageType,
      canSelectPageType,
      pageTypes: advancedSearchPageTypes().map((pageType) => ({
        value: pageType,
        label: pageType,
        selected: pageType === selectedPageType,
      })),
      routeBase,
      criteria: advancedSearchFormCriteria(criteria, taxonomy.tagTypes, taxonomy.tags),
      tagGroups: advancedSearchTagGroups(taxonomy.tagTypes, taxonomy.tags),
      pathOptions: pathOptionsByPageType[selectedPageType] ?? pathOptionsByPageType.all,
      pathOptionsByPageTypeJson: JSON.stringify(pathOptionsByPageType),
      nextCriterionIndex: Math.max(2, maxCriterionIndex + 1),
      operator,
      pageSize,
      sort,
      order,
      hasSearch,
      count: result.pagination.total,
      currentPage: result.pagination.currentPage,
      totalPages: result.pagination.totalPages,
      previousHref: result.pagination.currentPage > 1 ? `${routeBase}?${pageQuery(result.pagination.currentPage - 1)}` : '',
      nextHref: result.pagination.currentPage < result.pagination.totalPages ? `${routeBase}?${pageQuery(result.pagination.currentPage + 1)}` : '',
      resetHref: routeBase,
      exportHref: `${exportBase}?${queryWithoutPage}`,
      queryWithoutPage,
      pages: result.results.map((page) => ({
        ...page,
        isPublished: liveMap.has(page.uuid),
        liveWeight: liveMap.get(page.uuid)?.weight,
        hasLiveWeightDrift: liveMap.has(page.uuid) && liveMap.get(page.uuid)?.weight !== page.weight,
        hasLiveLectDrift: liveMap.has(page.uuid) && !lectsMatch(liveMap.get(page.uuid)?.lect, page.lect),
      })),
    }),
  );
}

function lectForPage(pageType: string, stored: string | null | undefined): Lect {
  return mergeLects(
    blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage),
    safeParseLect(stored),
  );
}

function lectFromForm(pageType: string, existing: Lect, form: FormData, language: string): Lect {
  const jsonLect = safeParseLect(str(form.get('lect_json')));
  const postedLect = postToLect(form, language);
  return mergeLects(
    mergeLects(blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage), existing),
    mergeLects(jsonLect, postedLect),
  );
}

function applyStructuredAction(lect: Lect, pageType: string, action: string, form: FormData): Lect {
  const next = normalizeLect(lect);
  const [actionType, actionParam = ''] = action.split(':');
  const actionParams = actionParam.split('|');
  const count = Math.max(1, num(form.get(`count:${actionParam}`), 1));

  if (actionType === 'block-add') {
    const blockName = str(form.get('block-select'));
    if (!blockName || !cmsConfig.blocks[blockName]) return next;
    const block = blockToLect(blockName, cmsConfig.blocks, cmsConfig.defaultLanguage);
    next._blocks ||= [];
    block._weight = getNextWeight(next._blocks);
    next._blocks.push(block);
    return next;
  }

  if (actionType === 'block-delete') {
    next._blocks?.splice(parseInt(actionParam, 10), 1);
    return next;
  }

  if (actionType === 'item-add') {
    addDefaultItem(next, pageType, actionParam, count);
    return next;
  }

  if (actionType === 'item-delete') {
    const [itemName, itemIndex] = actionParams;
    getMutableItems(next, itemName).splice(parseInt(itemIndex, 10), 1);
    return next;
  }

  if (actionType === 'block-item-add') {
    const [blockIndex, itemName] = actionParams;
    const block = getLectBlocks(next)[parseInt(blockIndex, 10)];
    if (block) addDefaultBlockItem(block, itemName, count);
    next._blocks = replaceBlock(next, parseInt(blockIndex, 10), block);
    return next;
  }

  if (actionType === 'block-item-delete') {
    const [blockIndex, itemName, itemIndex] = actionParams;
    const index = parseInt(blockIndex, 10);
    const block = getLectBlocks(next)[index];
    if (block) {
      getMutableItems(block, itemName).splice(parseInt(itemIndex, 10), 1);
      next._blocks = replaceBlock(next, index, block);
    }
    return next;
  }

  return next;
}

function addDefaultItem(lect: Lect, pageType: string, itemName: string, count: number): void {
  if (!itemName) return;
  const defaults = blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage);
  const defaultItem = getLectItems(defaults, itemName)[0] ?? defaultLectItem();
  const items = getMutableItems(lect, itemName);
  for (let index = 0; index < count; index++) {
    const item = cloneItem(defaultItem);
    item._weight = getNextWeight(items);
    items.push(item);
  }
}

function addDefaultBlockItem(block: Lect, itemName: string, count: number): void {
  if (!itemName) return;
  const blockType = String(block._type || 'default');
  const defaults = blockToLect(blockType, cmsConfig.blocks, cmsConfig.defaultLanguage);
  const defaultItem = getLectItems(defaults, itemName)[0] ?? defaultLectItem();
  const items = getMutableItems(block, itemName);
  for (let index = 0; index < count; index++) {
    const item = cloneItem(defaultItem);
    item._weight = getNextWeight(items);
    items.push(item);
  }
}

function cloneItem(item: LectItem): LectItem {
  return JSON.parse(JSON.stringify(item)) as LectItem;
}

function getMutableItems(lect: Lect, itemName: string): LectItem[] {
  if (!Array.isArray(lect[itemName])) lect[itemName] = [];
  return lect[itemName] as LectItem[];
}

function getNextWeight(items: LectItem[]): number {
  return items.reduce((max, entry) => Math.max(max, num(entry._weight, 0)), -1) + 1;
}

function replaceBlock(lect: Lect, index: number, block?: Lect): Lect[] {
  const blocks = getLectBlocks(lect);
  if (block) blocks[index] = block;
  return blocks;
}

function ensureDefaultLectName(lect: Lect, name: string): void {
  if (getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage)) return;
  const current = lect.name;
  const languageMap = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, string>
    : {};
  lect.name = {
    ...languageMap,
    [cmsConfig.defaultLanguage]: name,
  };
}

function safeAdminReturnPath(path: FormValue, fallback = '/admin'): string {
  const value = str(path);
  return value.startsWith('/admin') ? value : fallback;
}

function isStructuredEditorAction(action: string): boolean {
  return [
    'block-add',
    'block-delete',
    'item-add',
    'item-delete',
    'block-item-add',
    'block-item-delete',
  ].includes(action.split(':')[0] || '');
}

async function savePageVersion(
  db: D1Database,
  pageId: number,
  lect: string | null,
  action: string | null,
): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO page_versions (page_id, lect, action) VALUES (?, ?, ?)`,
  )
    .bind(pageId, lect, action)
    .run();
  const row = await db.prepare('SELECT id FROM page_versions WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  return row!.id;
}

async function publishPage(db: D1Database, pageId: number): Promise<boolean> {
  const page = await db.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return false;

  await db.prepare(
    `INSERT INTO live_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      page.uuid,
      page.name,
      page.slug,
      page.weight,
      page.start,
      page.end,
      page.page_type,
      page.lect,
      page.page_id,
      page.creator,
      page.editors,
    )
    .run();

  const livePage = await db.prepare('SELECT id FROM live_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();
  if (!livePage) return true;

  await db.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();

  const pageTags = await db.prepare('SELECT * FROM draft_page_tags WHERE page_id = ?')
    .bind(pageId)
    .all<PageTag>();
  for (const pageTag of pageTags.results) {
    await db.prepare(
      'INSERT INTO live_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind(pageTag.uuid, livePage.id, pageTag.tag_id, pageTag.weight)
      .run();
  }

  return true;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

adminRoutes.get('/', async (c) => {
  const user = c.get('user');
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';

  if (search) {
    return c.redirect(`/admin/advanced-search?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
  }

  const draftPages = await c.env.DB.prepare(
    'SELECT * FROM draft_pages ORDER BY weight ASC, name ASC',
  ).all<Page>();

  const livePages = await c.env.DB.prepare('SELECT uuid, lect, weight FROM live_pages').all<{
    uuid: string;
    lect: string | null;
    weight: number;
  }>();
  const liveMap = new Map(livePages.results.map((page) => [page.uuid, page]));

  const pages = draftPages.results.map((p) => ({
    ...p,
    isPublished: liveMap.has(p.uuid),
    liveWeight: liveMap.get(p.uuid)?.weight,
    hasLiveWeightDrift: liveMap.has(p.uuid) && liveMap.get(p.uuid)?.weight !== p.weight,
    hasLiveLectDrift: liveMap.has(p.uuid) && !lectsMatch(liveMap.get(p.uuid)?.lect, p.lect),
  }));

  // Fetch user avatar from DB
  const dbUser = await c.env.DB.prepare(
    'SELECT avatar_url FROM users WHERE id = ?',
  )
    .bind(parseInt(user.sub, 10))
    .first<{ avatar_url: string | null }>();

  return c.html(
    await dashboardPage(c.env.VIEWS, {
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      pages,
      flash: flash || undefined,
      returnPath: '/admin',
      searchAction: '/admin/advanced-search',
      advancedSearchHref: '/admin/advanced-search',
    }),
  );
});

// ── Page type workflows ──────────────────────────────────────────────────────

adminRoutes.get('/advanced-search', (c) => renderAdvancedSearch(c));

adminRoutes.get('/advanced-search-export', (c) => exportAdvancedSearch(c));

adminRoutes.get('/advanced-search-export/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return exportAdvancedSearch(c, pageType, false);
});

adminRoutes.get('/advanced-search/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return renderAdvancedSearch(c, pageType, false);
});

adminRoutes.get('/pages/list/:pageType', async (c) => {
  const user = c.get('user');
  const pageType = c.req.param('pageType');
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';

  if (search) {
    return c.redirect(`/admin/advanced-search/${encodeURIComponent(pageType)}?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
  }

  const draftPages = await c.env.DB.prepare(
    'SELECT * FROM draft_pages WHERE page_type = ? ORDER BY weight ASC, name ASC',
  )
    .bind(pageType)
    .all<Page>();
  const livePages = await c.env.DB.prepare('SELECT uuid, lect, slug, weight FROM live_pages').all<{
    uuid: string;
    lect: string | null;
    slug: string;
    weight: number;
  }>();
  const liveMap = new Map(livePages.results.map((page) => [page.uuid, page]));
  const dbUser = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
    .bind(parseInt(user.sub, 10))
    .first<{ avatar_url: string | null }>();

  return c.html(
    await dashboardPage(c.env.VIEWS, {
      siteTitle: `${c.env.SITE_TITLE ?? 'Worker CMS'} · ${pageType}`,
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      pages: draftPages.results.map((page) => ({
        ...page,
        isPublished: liveMap.has(page.uuid),
        liveWeight: liveMap.get(page.uuid)?.weight,
        hasLiveWeightDrift: liveMap.has(page.uuid) && liveMap.get(page.uuid)?.weight !== page.weight,
        hasLiveLectDrift: liveMap.has(page.uuid) && !lectsMatch(liveMap.get(page.uuid)?.lect, page.lect),
      })),
      flash: flash || undefined,
      returnPath: `/admin/pages/list/${encodeURIComponent(pageType)}`,
      pageTypeFilter: pageType,
      searchAction: `/admin/advanced-search/${encodeURIComponent(pageType)}`,
      advancedSearchHref: `/admin/advanced-search/${encodeURIComponent(pageType)}`,
    }),
  );
});

adminRoutes.get('/pages/search/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const search = c.req.query('search') ?? '';
  return c.redirect(`/admin/advanced-search/${encodeURIComponent(pageType)}?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
});

adminRoutes.get('/pages/create_by_type/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  return c.redirect(`/admin/pages/new?page_type=${encodeURIComponent(pageType)}`);
});

adminRoutes.post('/pages/new_post/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const creator = userIdFromContext(c);
  const name = str(form.get('name')) || `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const slug = str(form.get('slug')) || slugify(name);
  const lect = stringifyLect(
    withDraftMetadata(
      lectFromForm(
        pageType,
        blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage),
        form,
        language,
      ),
      userIdFromContext(c),
    ),
  );

  const result = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, slug, num(form.get('weight')), pageType, lect, creator || null, editorsFromForm(form))
    .run();
  const page = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  if (!page) return c.notFound();

  const versionId = await savePageVersion(c.env.DB, page.id, lect, 'create');
  await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
    .bind(versionId, page.id)
    .run();

  return c.redirect(`/admin/pages/${page.id}/edit`);
});

adminRoutes.get('/pages/import-v2/:pageType', async (c) => {
  const user = c.get('user');
  const pageType = c.req.param('pageType');
  const [dbUser, taxonomy] = await Promise.all([
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
    editorTaxonomy(c.env.DB),
  ]);

  return c.html(await importPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    pageType,
    mode: 'csv',
    action: `/admin/pages/import-v2/${encodeURIComponent(pageType)}`,
    sampleHeaders: exportHeaders([pageType], taxonomy.tagTypes),
  }));
});

adminRoutes.post('/pages/import-v2/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const csvText = await readImportCsvText(form);
  if (!csvText.trim()) {
    return c.redirect(`/admin/pages/list/${encodeURIComponent(pageType)}?flash=No+CSV+content+provided`);
  }

  const result = await importPagesCsv(c.env.DB, pageType, csvText, userIdFromContext(c));
  return c.redirect(
    `/admin/pages/list/${encodeURIComponent(pageType)}?flash=${result.created}+created,+${result.updated}+updated,+${result.skipped}+skipped`,
  );
});

adminRoutes.get('/pages/import/:pageType', async (c) => {
  const user = c.get('user');
  const pageType = c.req.param('pageType');
  const dbUser = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
    .bind(parseInt(user.sub, 10))
    .first<{ avatar_url: string | null }>();
  return c.html(await importPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    pageType,
  }));
});

adminRoutes.post('/pages/import/:pageType', async (c) => {
  const user = c.get('user');
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const raw = str(form.get('items'));
  const creator = parseInt(user.sub, 10) || null;
  const items = JSON.parse(raw) as Array<{
    name?: string;
    slug?: string;
    weight?: number;
    creator?: number | null;
    editors?: string | null;
    lect?: unknown;
    values?: Record<string, Record<string, string>>;
    attributes?: Record<string, string>;
    pointers?: Record<string, string>;
    items?: Record<string, LectItem[]>;
    blocks?: Lect[];
  }>;

  let imported = 0;
  for (const item of items) {
    const itemLect = item.lect
      ? normalizeLect(item.lect)
      : normalizeLect({
          attributes: {
            ...(item.attributes ?? {}),
            _type: pageType,
          },
          values: item.values,
          pointers: item.pointers,
          items: item.items,
          blocks: item.blocks,
        });
    const lect = withDraftMetadata(
      mergeLects(blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage), itemLect),
      userIdFromContext(c),
    );
    lect._type = pageType;
    const name = item.name ?? (getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || 'Untitled');
    const slug = item.slug ?? slugify(name);

    await c.env.DB.prepare(
      `INSERT INTO draft_pages (name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name,
         creator = COALESCE(draft_pages.creator, excluded.creator),
         editors = excluded.editors`,
    )
      .bind(
        name,
        slug,
        item.weight ?? 5,
        pageType,
        stringifyLect(lect),
        item.creator ?? creator,
        item.editors ?? null,
      )
      .run();
    imported++;
  }

  return c.redirect(`/admin/pages/list/${encodeURIComponent(pageType)}?flash=${imported}+item(s)+imported`);
});

// ── New page form ─────────────────────────────────────────────────────────────

adminRoutes.get('/pages/new', async (c) => {
  const user = c.get('user');
  const pageType = c.req.query('page_type') || 'default';
  const language = languageFromRequest(c);
  const lect = blueprintToLect(pageType, cmsConfig.blueprint, cmsConfig.defaultLanguage);
  const [parentPages, taxonomy, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
    editorTaxonomy(c.env.DB),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  return c.html(
    await editorPage(c.env.VIEWS, {
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      parentPages: parentPages.results,
      tags: taxonomy.tags,
      tagTypes: taxonomy.tagTypes,
      selectedTagIds: [],
      action: '/admin/pages',
      defaultPageType: pageType,
      structured: {
        config: cmsConfig,
        language,
        lect,
        blueprintProps: blueprintPropsFor(pageType),
        blockProps: blockPropsByName(),
        blockNames: cmsConfig.blockLists[pageType] ?? cmsConfig.blockLists.default,
        versions: [],
      },
    }),
  );
});

// ── Create page ───────────────────────────────────────────────────────────────

adminRoutes.post('/pages', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors: string[] = [];
  if (!name) errors.push('Page name is required.');
  if (!slug) errors.push('Slug is required.');
  if (!/^[a-z0-9-]+$/.test(slug)) errors.push('Slug may only contain lowercase letters, numbers and hyphens.');

  if (errors.length) {
    const [parentPages, taxonomy, dbUser] = await Promise.all([
      c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
      editorTaxonomy(c.env.DB),
      c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
        .bind(parseInt(user.sub, 10))
        .first<{ avatar_url: string | null }>(),
    ]);
    return c.html(
      await editorPage(c.env.VIEWS, {
        siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
        userName: user.name,
        userRole: user.role,
        userAvatar: dbUser?.avatar_url ?? '',
        parentPages: parentPages.results,
        tags: taxonomy.tags,
        tagTypes: taxonomy.tagTypes,
        selectedTagIds: [],
        errors,
        action: '/admin/pages',
        defaultPageType: nullableStr(form.get('page_type')) ?? 'default',
        structured: {
          config: cmsConfig,
          language,
          lect: lectFromForm(
            nullableStr(form.get('page_type')) ?? 'default',
            blueprintToLect(nullableStr(form.get('page_type')) ?? 'default', cmsConfig.blueprint, cmsConfig.defaultLanguage),
            form,
            language,
          ),
          blueprintProps: blueprintPropsFor(nullableStr(form.get('page_type')) ?? 'default'),
          blockProps: blockPropsByName(),
          blockNames: cmsConfig.blockLists[nullableStr(form.get('page_type')) ?? 'default'] ?? cmsConfig.blockLists.default,
          versions: [],
        },
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const weightVal = num(form.get('weight'));
  const creator = userIdFromContext(c);
  const editorsVal = editorsFromForm(form);
  const lectVal = stringifyLect(
    withDraftMetadata(
      lectFromForm(
        pageTypeVal,
        blueprintToLect(pageTypeVal, cmsConfig.blueprint, cmsConfig.defaultLanguage),
        form,
        language,
      ),
      userIdFromContext(c),
    ),
  );

  // Insert page
  const pageResult = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      name,
      slug,
      weightVal,
      startVal,
      endVal,
      pageTypeVal,
      lectVal,
      pageIdVal ? parseInt(pageIdVal, 10) : null,
      creator || null,
      editorsVal,
    )
    .run();

  // The schema uses a custom DEFAULT id expression (not INTEGER PRIMARY KEY),
  // so last_row_id is the internal rowid — we must SELECT the actual id back.
  const pageRow = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
    .bind(pageResult.meta.last_row_id)
    .first<{ id: number }>();
  const pageId = pageRow!.id;

  // Insert page version
  const versionId = await savePageVersion(c.env.DB, pageId, lectVal, 'create');

  // Link current version
  await c.env.DB.prepare(
    'UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(versionId, pageId)
    .run();

  // Save tag associations
  const tagIds = form.getAll('tag_ids');
  for (const tagId of tagIds) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)',
    )
      .bind(pageId, parseInt(String(tagId), 10))
      .run();
  }

  return c.redirect('/admin?flash=Page+created+successfully');
});

// ── Edit page form ────────────────────────────────────────────────────────────

adminRoutes.get('/pages/:id/edit', async (c) => {
  const user = c.get('user');
  const pageId = parseInt(c.req.param('id'), 10);
  const language = languageFromRequest(c);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const flash = c.req.query('flash') ?? '';

  const [page, parentPages, taxonomy, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>(),
    c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
    editorTaxonomy(c.env.DB),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  if (!page) return c.notFound();

  const [version, versions, livePage, pageTags] = await Promise.all([
    Number.isFinite(requestedVersionId)
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
          .bind(pageId, requestedVersionId)
          .first<PageVersion>()
      : page.current_page_version_id
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE id = ?')
          .bind(page.current_page_version_id)
          .first<PageVersion>()
      : Promise.resolve(null),
    c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
      .bind(pageId)
      .all<PageVersion>(),
    c.env.DB.prepare('SELECT lect FROM live_pages WHERE uuid = ?')
      .bind(page.uuid)
      .first<{ lect: string | null }>(),
    c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<{ tag_id: number }>(),
  ]);
  const pageType = page.page_type ?? 'default';
  const lect = lectForPage(pageType, version?.lect ?? page.lect);
  const displayPage = { ...page, lect: stringifyLect(lect) };

  return c.html(
    await editorPage(c.env.VIEWS, {
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      page: displayPage,
      version: version ?? undefined,
      isVersionPreview: Number.isFinite(requestedVersionId) && !!version,
      liveVersionId: versions.results.find((candidate) => candidate.lect === livePage?.lect)?.id,
      parentPages: parentPages.results,
      tags: taxonomy.tags,
      tagTypes: taxonomy.tagTypes,
      selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
      flash: flash || undefined,
      action: `/admin/pages/${pageId}`,
      structured: {
        config: cmsConfig,
        language,
        lect,
        blueprintProps: blueprintPropsFor(pageType),
        blockProps: blockPropsByName(),
        blockNames: cmsConfig.blockLists[pageType] ?? cmsConfig.blockLists.default,
        versions: versions.results,
      },
    }),
  );
});

adminRoutes.post('/pages/:id/weight', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const weight = num(form.get('weight'));
  const returnPath = safeAdminReturnPath(form.get('return_to'));

  const result = await c.env.DB.prepare('UPDATE draft_pages SET weight = ? WHERE id = ?')
    .bind(weight, pageId)
    .run();
  if (!result.success) {
    return c.redirect(`${returnPath}${returnPath.includes('?') ? '&' : '?'}flash=Weight+update+failed`);
  }

  return c.redirect(`${returnPath}${returnPath.includes('?') ? '&' : '?'}flash=Draft+weight+updated`);
});

// ── Update page ───────────────────────────────────────────────────────────────

adminRoutes.post('/pages/:id', async (c) => {
  const user = c.get('user');
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const action = str(form.get('action'));

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors: string[] = [];
  if (!name) errors.push('Page name is required.');
  if (!slug) errors.push('Slug is required.');
  if (slug && !/^[a-z0-9-]+$/.test(slug)) errors.push('Slug may only contain lowercase letters, numbers and hyphens.');

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  if (action.startsWith('revert:')) {
    const versionId = parseInt(action.split(':')[1], 10);
    const version = await c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
      .bind(pageId, versionId)
      .first<PageVersion>();
    if (!version) return c.notFound();
    await c.env.DB.prepare('UPDATE draft_pages SET lect = ?, current_page_version_id = ? WHERE id = ?')
      .bind(version.lect ?? page.lect, version.id, pageId)
      .run();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Version+restored`);
  }

  if (errors.length) {
    const [parentPages, taxonomy, version, versions, livePage, pageTags, dbUser] = await Promise.all([
      c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
      editorTaxonomy(c.env.DB),
      page.current_page_version_id
        ? c.env.DB.prepare('SELECT * FROM page_versions WHERE id = ?')
            .bind(page.current_page_version_id)
            .first<PageVersion>()
        : Promise.resolve(null),
      c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
        .bind(pageId)
        .all<PageVersion>(),
      c.env.DB.prepare('SELECT lect FROM live_pages WHERE uuid = ?')
        .bind(page.uuid)
        .first<{ lect: string | null }>(),
      c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?').bind(pageId).all<{ tag_id: number }>(),
      c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
        .bind(parseInt(user.sub, 10))
        .first<{ avatar_url: string | null }>(),
    ]);
    const pageType = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
    const lect = lectFromForm(pageType, lectForPage(pageType, page.lect), form, language);
    return c.html(
      await editorPage(c.env.VIEWS, {
        siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
        userName: user.name,
        userRole: user.role,
        userAvatar: dbUser?.avatar_url ?? '',
        page,
        version: version ?? undefined,
        liveVersionId: versions.results.find((candidate) => candidate.lect === livePage?.lect)?.id,
        parentPages: parentPages.results,
        tags: taxonomy.tags,
        tagTypes: taxonomy.tagTypes,
        selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
        errors,
        action: `/admin/pages/${pageId}`,
        structured: {
          config: cmsConfig,
          language,
          lect,
          blueprintProps: blueprintPropsFor(pageType),
          blockProps: blockPropsByName(),
          blockNames: cmsConfig.blockLists[pageType] ?? cmsConfig.blockLists.default,
          versions: versions.results,
        },
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const weightVal = num(form.get('weight'));
  const editorsVal = editorsFromForm(form);
  const lect = applyStructuredAction(
    lectFromForm(pageTypeVal, lectForPage(pageTypeVal, page.lect), form, language),
    pageTypeVal,
    action,
    form,
  );
  const lectVal = stringifyLect(withDraftMetadata(lect, userIdFromContext(c)));

  // Update page metadata
  await c.env.DB.prepare(
    `UPDATE draft_pages SET name=?, slug=?, weight=?, start=?, end=?, page_type=?, lect=?, page_id=?, editors=? WHERE id=?`,
  )
    .bind(
      name,
      slug,
      weightVal,
      startVal,
      endVal,
      pageTypeVal,
      lectVal,
      pageIdVal ? parseInt(pageIdVal, 10) : null,
      editorsVal,
      pageId,
    )
    .run();

  const newVersionId = await savePageVersion(
    c.env.DB,
    pageId,
    lectVal,
    action || 'update',
  );

  await c.env.DB.prepare(
    'UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(newVersionId, pageId)
    .run();

  // Replace tag associations
  await c.env.DB.prepare('DELETE FROM draft_page_tags WHERE page_id = ?')
    .bind(pageId)
    .run();

  const tagIds = form.getAll('tag_ids');
  for (const tagId of tagIds) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)',
    )
      .bind(pageId, parseInt(String(tagId), 10))
      .run();
  }

  if (action === 'publish') {
    await publishPage(c.env.DB, pageId);
    return c.redirect('/admin?flash=Page+published+successfully');
  }

  if (isStructuredEditorAction(action)) {
    return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}`);
  }

  return c.redirect('/admin?flash=Page+updated+successfully');
});

// ── Publish (DRAFT → LIVE) ────────────────────────────────────────────────────

adminRoutes.post('/pages/:id/publish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const published = await publishPage(c.env.DB, pageId);
  if (!published) return c.notFound();

  return c.redirect('/admin?flash=Page+published+successfully');
});

// ── Unpublish (remove from LIVE) ──────────────────────────────────────────────

adminRoutes.post('/pages/:id/unpublish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT uuid FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string }>();
  if (!page) return c.notFound();

  const livePage = await c.env.DB.prepare('SELECT id FROM live_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();
  if (livePage) {
    await c.env.DB.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();
  }

  await c.env.DB.prepare('DELETE FROM live_pages WHERE uuid = ?')
    .bind(page.uuid)
    .run();

  return c.redirect('/admin?flash=Page+unpublished');
});

// ── Delete page → move to TRASH (soft-delete) ────────────────────────────────

adminRoutes.post('/pages/:id/delete', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  // Copy page into trash table (preserve uuid so we can restore)
  await c.env.DB.prepare(
    `INSERT INTO trash_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      page.uuid,
      page.name,
      page.slug,
      page.weight,
      page.start,
      page.end,
      page.page_type,
      page.lect,
      page.page_id,
      page.creator,
      page.editors,
    )
    .run();

  // Fetch the trash page id
  const trashPage = await c.env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();

  if (trashPage) {
    // Copy page tags into trash
    const pageTags = await c.env.DB.prepare('SELECT * FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<PageTag>();
    for (const pt of pageTags.results) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO trash_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)`,
      )
        .bind(pt.uuid, trashPage.id, pt.tag_id, pt.weight)
        .run();
    }
  }

  const livePage = await c.env.DB.prepare('SELECT id FROM live_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();
  if (livePage) {
    await c.env.DB.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();
  }

  // Unpublish from live (remove by uuid)
  await c.env.DB.prepare('DELETE FROM live_pages WHERE uuid = ?').bind(page.uuid).run();

  // Delete from DRAFT
  await c.env.DB.prepare('DELETE FROM draft_pages WHERE id = ?').bind(pageId).run();

  return c.redirect('/admin?flash=Page+moved+to+trash');
});

// ── Trash list ────────────────────────────────────────────────────────────────

adminRoutes.get('/trash', async (c) => {
  const user = c.get('user');
  const flash = c.req.query('flash') ?? '';

  const [trashedPages, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM trash_pages ORDER BY updated_at DESC').all<Page>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  return c.html(await trashPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    pages: trashedPages.results,
    flash: flash || undefined,
  }));
});

// ── Restore page from trash → draft ──────────────────────────────────────────

adminRoutes.post('/trash/:id/restore', async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);

  const trashPage = await c.env.DB.prepare('SELECT * FROM trash_pages WHERE id = ?')
    .bind(trashId)
    .first<Page>();
  if (!trashPage) return c.notFound();

  // Upsert page back into draft page table (match on uuid)
  await c.env.DB.prepare(
    `INSERT INTO draft_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      trashPage.uuid,
      trashPage.name,
      trashPage.slug,
      trashPage.weight,
      trashPage.start,
      trashPage.end,
      trashPage.page_type,
      trashPage.lect,
      trashPage.page_id,
      trashPage.creator,
      trashPage.editors,
    )
    .run();

  const draftPage = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE uuid = ?')
    .bind(trashPage.uuid)
    .first<{ id: number }>();

  if (draftPage) {
    const restoredVersionId = await savePageVersion(
      c.env.DB,
      draftPage.id,
      trashPage.lect,
      'restore',
    );

    // Restore page tags to draft
    const trashTags = await c.env.DB.prepare('SELECT * FROM trash_page_tags WHERE page_id = ?')
      .bind(trashId)
      .all<PageTag>();
    for (const pt of trashTags.results) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO draft_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)`,
      )
        .bind(pt.uuid, draftPage.id, pt.tag_id, pt.weight)
        .run();
    }

    await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
      .bind(restoredVersionId, draftPage.id)
      .run();
  }

  // Remove from TRASH
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();

  return c.redirect('/admin/trash?flash=Page+restored+to+draft');
});

// ── Permanently delete from trash ─────────────────────────────────────────────

adminRoutes.post('/trash/:id/delete', async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();
  return c.redirect('/admin/trash?flash=Page+permanently+deleted');
});

// ── Admin JSON API ───────────────────────────────────────────────────────────

adminRoutes.get('/api/pages/:type', async (c) => {
  const pageType = c.req.param('type');
  const pages = await c.env.DB.prepare('SELECT id, name FROM draft_pages WHERE page_type = ? ORDER BY name ASC')
    .bind(pageType)
    .all<{ id: number; name: string }>();
  return c.json(pages.results.map((page) => ({ page: page.id, name: page.name })));
});

adminRoutes.get('/api/tags/:type', async (c) => {
  const type = c.req.param('type');
  const tagType = await c.env.DB.prepare('SELECT * FROM tag_types WHERE name = ? OR slug = ?')
    .bind(type, type)
    .first<TagType>();
  if (!tagType) return c.json([]);
  const tags = await c.env.DB.prepare('SELECT * FROM tags WHERE tag_type_id = ? ORDER BY name ASC')
    .bind(tagType.id)
    .all<Tag>();
  return c.json(tags.results.map((tag) => ({
    value: tag.id,
    label: getLectLocalizedValue(safeParseLect(tag.lect), 'name', cmsConfig.defaultLanguage) || tag.name,
  })));
});

adminRoutes.post('/api/page/:pageId/tag/:tagId', async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  const tagId = parseInt(c.req.param('tagId'), 10);
  const existing = await c.env.DB.prepare(
    'SELECT id FROM draft_page_tags WHERE page_id = ? AND tag_id = ?',
  )
    .bind(pageId, tagId)
    .first<{ id: number }>();
  if (existing) {
    return c.json({ type: 'ADD_PAGE_TAG', payload: { success: false, message: 'tag exist', id: existing.id } });
  }
  const result = await c.env.DB.prepare('INSERT INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
    .bind(pageId, tagId)
    .run();
  const pageTag = await c.env.DB.prepare('SELECT id FROM draft_page_tags WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  await c.env.DB.prepare('UPDATE draft_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(pageId).run();
  return c.json({ type: 'ADD_PAGE_TAG', payload: { success: true, id: pageTag?.id } });
});

adminRoutes.delete('/api/page/remove/page_tag/:id', async (c) => deletePageTagApi(c));
adminRoutes.delete('/api/page_tag/:id', async (c) => deletePageTagApi(c));

async function deletePageTagApi(c: AdminContext) {
  const id = parseInt(c.req.param('id') ?? '', 10);
  const pageTag = await c.env.DB.prepare('SELECT page_id FROM draft_page_tags WHERE id = ?')
    .bind(id)
    .first<{ page_id: number }>();
  await c.env.DB.prepare('DELETE FROM draft_page_tags WHERE id = ?').bind(id).run();
  if (pageTag) {
    await c.env.DB.prepare('UPDATE draft_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(pageTag.page_id)
      .run();
  }
  return c.json({ type: 'DELETE_PAGE_TAG', payload: { success: true, id } });
}

// ── Upload ───────────────────────────────────────────────────────────────────

adminRoutes.post('/upload', async (c) => {
  if (!c.env.MEDIA_BUCKET) {
    return c.json({ success: false, error: 'MEDIA_BUCKET binding is not configured' }, 501);
  }

  const form = await c.req.formData();
  const uploadDirectory = slugify(str(form.get('dir')) || 'upload');
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${now.getUTCMonth() + 1}/${now.getUTCDate()}`;
  const files: string[] = [];

  for (const [, value] of form.entries()) {
    if (typeof value === 'string') continue;
    const file = value as File;
    if (!file.name) continue;
    const safeName = file.name.replace(/[^a-z0-9-_.]/gi, '');
    const key = `${uploadDirectory}/${datePath}/${crypto.randomUUID()}-${safeName}`;
    await c.env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || undefined },
    });
    const url = `/media/${key}`;
    await c.env.DB.prepare(
      'INSERT INTO media_files (key, url, filename, content_type, size) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(key, url, file.name, file.type || null, file.size)
      .run();
    files.push(url);
  }

  return c.json({ success: true, files });
});

// ── Tag types ─────────────────────────────────────────────────────────────────

adminRoutes.get('/tag-types', async (c) => {
  const user = c.get('user');
  const [tagTypes, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  return c.html(await tagTypesPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    tagTypes: tagTypes.results,
  }));
});

adminRoutes.get('/tag-types/new', async (c) => tagTypeForm(c));

adminRoutes.post('/tag-types', async (c) => {
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  if (!name || !slug) return c.redirect('/admin/tag-types/new?error=missing');
  await c.env.DB.prepare('INSERT INTO tag_types (name, slug) VALUES (?, ?)')
    .bind(name, slug)
    .run();
  return c.redirect('/admin/tag-types');
});

adminRoutes.get('/tag-types/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tagType = await c.env.DB.prepare('SELECT * FROM tag_types WHERE id = ?')
    .bind(id)
    .first<TagType>();
  if (!tagType) return c.notFound();
  return tagTypeForm(c, tagType);
});

adminRoutes.post('/tag-types/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  await c.env.DB.prepare('UPDATE tag_types SET name = ?, slug = ? WHERE id = ?')
    .bind(name, slug, id)
    .run();
  return c.redirect('/admin/tag-types');
});

adminRoutes.post('/tag-types/:id/delete', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('UPDATE tags SET tag_type_id = NULL WHERE tag_type_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM tag_types WHERE id = ?').bind(id).run();
  return c.redirect('/admin/tag-types');
});

// ── Tags ─────────────────────────────────────────────────────────────────────

adminRoutes.get('/tags', async (c) => {
  const user = c.get('user');
  const filterTagType = parseInt(c.req.query('filter_tag_type') ?? '0', 10);
  const [tagTypes, tags, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
    filterTagType
      ? c.env.DB.prepare('SELECT * FROM tags WHERE tag_type_id = ? ORDER BY name ASC').bind(filterTagType).all<Tag>()
      : c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);
  return c.html(await tagsPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    tagTypes: tagTypes.results,
    tags: tags.results,
    filterTagType,
  }));
});

adminRoutes.get('/tags/new', async (c) => tagForm(c));

adminRoutes.post('/tags', async (c) => {
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const lect = postToLect(form, language);
  ensureDefaultLectName(lect, name);
  await c.env.DB.prepare(
    'INSERT INTO tags (name, slug, tag_type_id, parent_tag, lect) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(name, slug, nullableStr(form.get('tag_type_id')) ? num(form.get('tag_type_id')) : null, nullableStr(form.get('parent_tag')) ? num(form.get('parent_tag')) : null, stringifyLect(lect))
    .run();
  return c.redirect('/admin/tags');
});

adminRoutes.get('/tags/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tag = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!tag) return c.notFound();
  return tagForm(c, tag);
});

adminRoutes.post('/tags/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const existing = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!existing) return c.notFound();
  const lect = mergeLects(safeParseLect(existing.lect), postToLect(form, language));
  ensureDefaultLectName(lect, name);
  await c.env.DB.prepare(
    'UPDATE tags SET name = ?, slug = ?, tag_type_id = ?, parent_tag = ?, lect = ? WHERE id = ?',
  )
    .bind(name, slug, nullableStr(form.get('tag_type_id')) ? num(form.get('tag_type_id')) : null, nullableStr(form.get('parent_tag')) ? num(form.get('parent_tag')) : null, stringifyLect(lect), id)
    .run();
  return c.redirect('/admin/tags');
});

adminRoutes.post('/tags/:id/delete', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await Promise.all([
    c.env.DB.prepare('DELETE FROM draft_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.DB.prepare('DELETE FROM live_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.DB.prepare('DELETE FROM trash_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.DB.prepare('UPDATE tags SET parent_tag = NULL WHERE parent_tag = ?').bind(id).run(),
  ]);
  await c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
  return c.redirect('/admin/tags');
});

async function tagTypeForm(c: AdminContext, tagType?: TagType) {
  const user = c.get('user');
  const dbUser = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
    .bind(parseInt(user.sub, 10))
    .first<{ avatar_url: string | null }>();
  return c.html(await tagTypeFormPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    tagType,
  }));
}

async function tagForm(c: AdminContext, tag?: Tag) {
  const user = c.get('user');
  const language = languageFromRequest(c);
  const [tagTypes, tags, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
    c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);
  const lect = safeParseLect(tag?.lect);
  const rawTranslatedName = getLectLocalizedValue(lect, 'name', language);
  const translatedName = language === cmsConfig.defaultLanguage ? rawTranslatedName || tag?.name || '' : rawTranslatedName;
  const defaultTranslatedName = getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || tag?.name || '';
  const translatedPlaceholder = language === cmsConfig.defaultLanguage ? '' : defaultTranslatedName;
  return c.html(await tagFormPage(c.env.VIEWS, {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: dbUser?.avatar_url ?? '',
    tag,
    language,
    languages: cmsConfig.languages,
    translatedName,
    translatedPlaceholder,
    tagTypes: tagTypes.results,
    parentTags: tags.results,
  }));
}
