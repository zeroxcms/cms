// CSV parsing, export formatting, and import (preview + apply) logic for admin pages.

import { cmsConfig } from '../cms-config';
import type { CmsConfig } from '../cms-config';
import type { Page, TagType } from '../types';
import {
  blueprintToLect,
  getLectLocalizedValue,
  normalizeLect,
  stringifyLect,
} from './lect';
import type { Lect, LectItem } from './lect';
import { num, slugify, str } from './forms';
import type { CsvImportMode } from './forms';
import {
  advancedSearchPathSpecs,
  childPath,
  getPathValue,
} from './search';
import type { BlueprintPathKind } from './search';
import { editorTaxonomy, savePageVersion } from './admin-queries';
import { lectForPage, withDraftMetadata } from './page-logic';

export interface CsvPathSpec {
  header: string;
  sourcePath: string;
  kind: BlueprintPathKind;
  language?: string;
}

export interface CsvImportResult {
  created: number;
  updated: number;
  skipped: number;
}

export interface CsvImportPreviewRow {
  rowNumber: number;
  action: 'create' | 'update';
  name: string;
  slug: string;
  existingId: number | null;
  existingName: string;
  existingSlug: string;
}

export interface CsvImportPreview {
  rows: CsvImportPreviewRow[];
  skipped: number;
}

export interface ImportCsvRow {
  index: number;
  row: Record<string, string>;
}

export interface BulkImportedPagePayload {
  id: number;
  version_id: number;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  page_type: string;
  lect: string;
  creator: number | null;
}

export interface PreparedImportedPage {
  payload: BulkImportedPagePayload;
  row: Record<string, string>;
}

const IMPORT_LOOKUP_CHUNK_ROWS = 1000;
const IMPORT_BULK_CHUNK_ROWS = 1000;
const IMPORT_BULK_CHUNK_BYTES = 1_500_000;

export function csvPathSpecs(pageTypes: string[], includeLegacyLocalized = false, config: CmsConfig = cmsConfig): CsvPathSpec[] {
  return advancedSearchPathSpecs(pageTypes, config).flatMap<CsvPathSpec>((spec) => {
    if (spec.kind !== 'localized') {
      return [{ header: spec.path, sourcePath: spec.path, kind: spec.kind }];
    }

    const localized = cmsConfig.languages.map((language) => ({
      header: `${spec.path}.${language}`,
      sourcePath: spec.path,
      kind: spec.kind,
      language,
    }));

    return includeLegacyLocalized
      ? [{ header: spec.path, sourcePath: spec.path, kind: spec.kind, language: cmsConfig.defaultLanguage }, ...localized]
      : localized;
  });
}

export function exportCsvPathSpecs(pageTypes: string[], lects: Lect[]): CsvPathSpec[] {
  const specs = new Map<string, CsvPathSpec>();
  for (const spec of csvPathSpecs(pageTypes)) specs.set(spec.header, spec);
  for (const spec of dataCsvPathSpecs(lects)) {
    if (!specs.has(spec.header)) specs.set(spec.header, spec);
  }
  return Array.from(specs.values());
}

function dataCsvPathSpecs(lects: Lect[]): CsvPathSpec[] {
  const specs = new Map<string, CsvPathSpec>();
  for (const lect of lects) collectDataCsvPathSpecs(lect, '', specs);
  return Array.from(specs.values());
}

function collectDataCsvPathSpecs(value: unknown, path: string, specs: Map<string, CsvPathSpec>): void {
  if (isCsvScalar(value)) {
    if (path) addDataCsvPathSpec(specs, { header: path, sourcePath: path, kind: dataCsvPathKind(path) });
    return;
  }

  if (Array.isArray(value)) {
    if (value.some(isCsvScalar)) {
      addDataCsvPathSpec(specs, { header: path, sourcePath: path, kind: dataCsvPathKind(path) });
    }
    for (const item of value) {
      if (isPlainRecord(item)) collectDataCsvPathSpecs(item, `${path}[*]`, specs);
    }
    return;
  }

  if (!isPlainRecord(value)) return;

  const languageEntries = cmsConfig.languages.filter((language) => isCsvScalar(value[language]));
  if (path && languageEntries.length > 0) {
    for (const language of cmsConfig.languages) {
      addDataCsvPathSpec(specs, {
        header: `${path}.${language}`,
        sourcePath: path,
        kind: 'localized',
        language,
      });
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    if (languageEntries.length > 0 && cmsConfig.languages.includes(key) && isCsvScalar(entry)) continue;
    if (shouldSkipDataCsvPath(key, path)) continue;
    collectDataCsvPathSpecs(entry, childPath(path, key), specs);
  }
}

function addDataCsvPathSpec(specs: Map<string, CsvPathSpec>, spec: CsvPathSpec): void {
  if (!spec.header || specs.has(spec.header)) return;
  specs.set(spec.header, spec);
}

function dataCsvPathKind(path: string): BlueprintPathKind {
  return path.startsWith('_pointers.') ? 'pointer' : 'scalar';
}

function isCsvScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shouldSkipDataCsvPath(key: string, parentPath: string): boolean {
  return !parentPath && ['_modifier', '_type', '_updated_at'].includes(key);
}

export function csvFormatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  const escaped = text.replace(/"/g, '""');
  if (/[",\r\n]/.test(text)) return `"${escaped}"`;
  if (/^[\d\s\-+()]+$/.test(text) && /\d/.test(text)) return `="${escaped}"`;
  return escaped;
}

export function parseCsv(text: string): string[][] {
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

export function csvRowsToObjects(rows: string[][]): Array<Record<string, string>> {
  const [headers = [], ...dataRows] = rows;
  return dataRows.map((row) => Object.fromEntries(headers.map((header, index) => [
    header.trim().replace(/^﻿/, ''),
    row[index] ?? '',
  ])));
}

function splitListValue(value: string): string[] {
  return value.split(';').map((entry) => entry.trim()).filter(Boolean);
}

function hasCsvColumn(row: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function csvCellHasValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function csvRowHasValues(row: Record<string, string>): boolean {
  return Object.values(row).some(csvCellHasValue);
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

function getCsvLectValue(lect: Lect, spec: CsvPathSpec): string {
  const path = spec.language ? `${spec.sourcePath}.${spec.language}` : spec.sourcePath;
  return getLectValueByPath(lect, path);
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

function setLectPathValue(lect: Lect, path: string, kind: BlueprintPathKind, value: string, language = cmsConfig.defaultLanguage): void {
  const wildcardMatch = path.match(/^(.+?)\[\*\]\.(.+)$/);
  if (wildcardMatch) {
    const [itemName, childPathValue] = [wildcardMatch[1], wildcardMatch[2]];
    const values = splitListValue(value);
    if (!Array.isArray(lect[itemName])) lect[itemName] = [];
    const items = lect[itemName] as LectItem[];
    values.forEach((entry, index) => {
      items[index] ||= {};
      setLectPathValue(items[index], childPathValue, kind, entry, language);
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
  if (kind === 'localized') {
    const current = target[field];
    const values = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
    target[field] = { ...values, [language]: value };
    return;
  }

  target[field] = value;
}

export function exportHeaders(pathColumns: CsvPathSpec[], tagTypes: TagType[]): string[] {
  return [
    'id',
    'uuid',
    'name',
    'slug',
    'weight',
    'start',
    'end',
    'page_type',
    ...pathColumns.map((spec) => spec.header),
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

export async function exportPagesCsv(db: D1Database, pages: Page[], pageTypes: string[], config: CmsConfig = cmsConfig): Promise<string> {
  const taxonomy = await editorTaxonomy(db);
  const pageLects = pages.map((page) => ({
    page,
    lect: lectForPage(config, page.page_type ?? 'default', page.lect),
  }));
  const pathColumns = exportCsvPathSpecs(pageTypes, pageLects.map(({ lect }) => lect));
  const headers = exportHeaders(pathColumns, taxonomy.tagTypes);
  const tagsByPage = await pageTagsForExport(db);
  const rows = [headers];

  for (const { page, lect } of pageLects) {
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
      ...pathColumns.map((spec) => getCsvLectValue(lect, spec)),
      ...taxonomy.tagTypes.map((tagType) => (tagGroups[tagType.name] ?? []).join('; ')),
    ]);
  }

  return `﻿${rows.map((row) => row.map(csvFormatValue).join(',')).join('\n')}`;
}

export function csvDownloadResponse(csv: string, filename: string): Response {
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

export async function readImportCsvText(form: FormData): Promise<string> {
  const file = form.get('file') as unknown;
  if (file && typeof file === 'object' && 'text' in file && 'size' in file) {
    const upload = file as { size: number; text: () => Promise<string> };
    if (upload.size > 0) return upload.text();
  }
  return str(form.get('csv'));
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function jsonByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function chunkByJsonPayload<T>(rows: T[], maxRows: number, maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let chunkBytes = 2;

  for (const row of rows) {
    const rowBytes = jsonByteLength(JSON.stringify(row)) + (chunk.length ? 1 : 0);
    if (chunk.length && (chunk.length >= maxRows || chunkBytes + rowBytes > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(row);
    chunkBytes += rowBytes;
  }

  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function importLookupPayload(rows: ImportCsvRow[]): Array<{ index: number; id: string; slug: string }> {
  return rows.map(({ index, row }) => {
    const id = row.id?.trim() ?? '';
    return {
      index,
      id: /^-?\d+$/.test(id) ? id : '',
      slug: row.slug?.trim() ?? '',
    };
  });
}

async function findImportTargets(
  db: D1Database,
  pageType: string,
  rows: ImportCsvRow[],
): Promise<Map<number, Page>> {
  const matches = new Map<number, Page>();
  const lookupRows = rows.filter(({ row }) => row.id?.trim() || row.slug?.trim());
  if (!lookupRows.length) return matches;

  for (const chunk of chunkRows(lookupRows, IMPORT_LOOKUP_CHUNK_ROWS)) {
    const payload = JSON.stringify(importLookupPayload(chunk));
    const pages = await db.prepare(
      `WITH incoming AS (
         SELECT
           CAST(json_extract(value, '$.index') AS INTEGER) AS row_index,
           NULLIF(json_extract(value, '$.id'), '') AS row_id,
           NULLIF(json_extract(value, '$.slug'), '') AS slug
         FROM json_each(?)
       )
       SELECT incoming.row_index AS row_index, p.*
       FROM incoming
       JOIN draft_pages p
         ON p.page_type = ?
        AND (
          (incoming.row_id IS NOT NULL AND p.id = CAST(incoming.row_id AS INTEGER))
          OR (incoming.slug IS NOT NULL AND p.slug = incoming.slug)
        )
       ORDER BY incoming.row_index ASC,
         CASE
           WHEN incoming.row_id IS NOT NULL AND p.id = CAST(incoming.row_id AS INTEGER) THEN 0
           ELSE 1
         END ASC,
         p.id ASC`,
    )
      .bind(payload, pageType)
      .all<Page & { row_index: number }>();

    for (const page of pages.results) {
      if (!matches.has(page.row_index)) matches.set(page.row_index, page);
    }
  }

  return matches;
}

function generatedImportIdBase(): number {
  const buckets = new Uint32Array(1);
  crypto.getRandomValues(buckets);
  return 4_000_000_000_000_000 + (buckets[0] % 10_000_000) * 100_000;
}

function prepareImportedPage(
  pageType: string,
  row: Record<string, string>,
  userId: number,
  pathSpecs: CsvPathSpec[],
  idBase: number,
  index: number,
  config: CmsConfig = cmsConfig,
): PreparedImportedPage {
  const lect = normalizeLect(blueprintToLect(pageType, config.blueprint, config.defaultLanguage));
  applyCsvLectValues(lect, row, pathSpecs, 'replace');

  lect._type = pageType;
  const name = row.name?.trim() || getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || `Untitled ${pageType}`;
  const slug = row.slug?.trim() || slugify(name);

  return {
    row,
    payload: {
      id: idBase + (index * 2),
      version_id: idBase + (index * 2) + 1,
      name,
      slug,
      weight: row.weight ? num(row.weight) : 5,
      start: row.start?.trim() || null,
      end: row.end?.trim() || null,
      page_type: pageType,
      lect: stringifyLect(withDraftMetadata(lect, userId)),
      creator: userId || null,
    },
  };
}

async function bulkCreateImportedPages(
  db: D1Database,
  pages: PreparedImportedPage[],
  taxonomy: { tagTypes: TagType[] },
): Promise<void> {
  for (const chunk of chunkByJsonPayload(pages, IMPORT_BULK_CHUNK_ROWS, IMPORT_BULK_CHUNK_BYTES)) {
    const payload = JSON.stringify(chunk.map((page) => page.payload));

    await db.prepare(
      `WITH incoming AS (
         SELECT
           CAST(json_extract(value, '$.id') AS INTEGER) AS id,
           CAST(json_extract(value, '$.version_id') AS INTEGER) AS version_id,
           json_extract(value, '$.name') AS name,
           json_extract(value, '$.slug') AS slug,
           CAST(json_extract(value, '$.weight') AS INTEGER) AS weight,
           json_extract(value, '$.start') AS start,
           json_extract(value, '$.end') AS end,
           json_extract(value, '$.page_type') AS page_type,
           json_extract(value, '$.lect') AS lect,
           CAST(json_extract(value, '$.creator') AS INTEGER) AS creator
         FROM json_each(?)
       )
       INSERT INTO draft_pages (id, name, slug, weight, start, end, page_type, current_page_version_id, lect, creator)
       SELECT id, name, slug, weight, start, end, page_type, version_id, lect, creator
       FROM incoming`,
    )
      .bind(payload)
      .run();

    await db.prepare(
      `WITH incoming AS (
         SELECT
           CAST(json_extract(value, '$.id') AS INTEGER) AS page_id,
           CAST(json_extract(value, '$.version_id') AS INTEGER) AS version_id,
           json_extract(value, '$.lect') AS lect
         FROM json_each(?)
       )
       INSERT INTO page_versions (id, page_id, lect, action)
       SELECT version_id, page_id, lect, 'import'
       FROM incoming`,
    )
      .bind(payload)
      .run();

    for (const page of chunk) {
      await importPageTags(db, page.payload.id, page.row, taxonomy.tagTypes, 'replace');
    }
  }
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

async function importPageTags(
  db: D1Database,
  pageId: number,
  row: Record<string, string>,
  tagTypes: TagType[],
  mode: 'replace' | 'append' = 'replace',
): Promise<boolean> {
  let changed = false;
  for (const tagType of tagTypes) {
    const header = `tag:${tagType.name}`;
    const value = row[header] ?? row[tagType.name];
    if (value === undefined) continue;

    if (mode === 'replace') {
      await db.prepare(
        `DELETE FROM draft_page_tags
         WHERE page_id = ? AND tag_id IN (SELECT id FROM tags WHERE tag_type_id = ?)`,
      )
        .bind(pageId, tagType.id)
        .run();
      changed = true;
    }

    for (const tagName of splitListValue(value)) {
      const tagId = await ensureTag(db, tagType, tagName);
      const existing = await db.prepare('SELECT id FROM draft_page_tags WHERE page_id = ? AND tag_id = ?')
        .bind(pageId, tagId)
        .first<{ id: number }>();
      if (existing) continue;
      await db.prepare('INSERT INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
        .bind(pageId, tagId)
        .run();
      changed = true;
    }
  }
  return changed;
}

export async function previewPagesCsv(db: D1Database, pageType: string, csvText: string, config: CmsConfig = cmsConfig): Promise<CsvImportPreview> {
  const rows = csvRowsToObjects(parseCsv(csvText));
  const pathSpecs = csvPathSpecs([pageType], true, config);
  const preview: CsvImportPreview = { rows: [], skipped: 0 };
  const importRows = rows.map((row, index) => ({ index, row })).filter(({ row }) => csvRowHasValues(row));
  const targets = await findImportTargets(db, pageType, importRows);

  for (const [index, row] of rows.entries()) {
    if (!csvRowHasValues(row)) {
      preview.skipped++;
      continue;
    }

    const existing = targets.get(index) ?? null;
    const baseLect = existing ? lectForPage(config, pageType, existing.lect) : blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
    const lect = normalizeLect(baseLect);

    for (const spec of pathSpecs) {
      if (!(spec.header in row)) continue;
      setLectPathValue(lect, spec.sourcePath, spec.kind, row[spec.header] ?? '', spec.language);
    }

    const name = row.name?.trim() || getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || existing?.name || `Untitled ${pageType}`;
    const slug = row.slug?.trim() || existing?.slug || slugify(name);
    const action = existing ? 'update' : 'create';

    preview.rows.push({
      rowNumber: index + 2,
      action,
      name,
      slug,
      existingId: existing?.id ?? null,
      existingName: existing?.name ?? '',
      existingSlug: existing?.slug ?? '',
    });
  }

  return preview;
}

function applyCsvLectValues(
  lect: Lect,
  row: Record<string, string>,
  pathSpecs: CsvPathSpec[],
  mode: 'replace' | 'append',
): boolean {
  let changed = false;
  for (const spec of pathSpecs) {
    if (!hasCsvColumn(row, spec.header)) continue;
    const value = row[spec.header] ?? '';
    if (mode === 'append') {
      if (!csvCellHasValue(value)) continue;
      if (getCsvLectValue(lect, spec).trim() !== '') continue;
    }
    setLectPathValue(lect, spec.sourcePath, spec.kind, value, spec.language);
    changed = true;
  }
  return changed;
}

async function updateImportedPage(
  db: D1Database,
  pageType: string,
  row: Record<string, string>,
  existing: Page,
  userId: number,
  taxonomy: { tagTypes: TagType[] },
  pathSpecs: CsvPathSpec[],
  mode: 'replace' | 'append',
  config: CmsConfig = cmsConfig,
): Promise<boolean> {
  const lect = normalizeLect(lectForPage(config, pageType, existing.lect));
  let changed = applyCsvLectValues(lect, row, pathSpecs, mode);
  let name = existing.name;
  let slug = existing.slug;
  let weight = existing.weight ?? 5;
  let start = existing.start;
  let end = existing.end;

  if (mode === 'append') {
    if (csvCellHasValue(row.name) && !existing.name?.trim()) {
      name = row.name.trim();
      changed = true;
    }
    if (csvCellHasValue(row.slug) && !existing.slug?.trim()) {
      slug = row.slug.trim();
      changed = true;
    }
    if (csvCellHasValue(row.weight) && existing.weight === null) {
      weight = num(row.weight);
      changed = true;
    }
    if (csvCellHasValue(row.start) && !existing.start) {
      start = row.start.trim();
      changed = true;
    }
    if (csvCellHasValue(row.end) && !existing.end) {
      end = row.end.trim();
      changed = true;
    }
  } else {
    if (hasCsvColumn(row, 'name')) {
      name = row.name?.trim() || getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || existing.name || `Untitled ${pageType}`;
      changed = true;
    }
    if (hasCsvColumn(row, 'slug')) {
      slug = row.slug?.trim() || existing.slug || slugify(name);
      changed = true;
    }
    if (hasCsvColumn(row, 'weight') && csvCellHasValue(row.weight)) {
      weight = num(row.weight);
      changed = true;
    }
    if (hasCsvColumn(row, 'start')) {
      start = row.start?.trim() || null;
      changed = true;
    }
    if (hasCsvColumn(row, 'end')) {
      end = row.end?.trim() || null;
      changed = true;
    }
  }

  lect._type = pageType;
  const lectValue = stringifyLect(withDraftMetadata(lect, userId));
  const tagsChanged = await importPageTags(db, existing.id, row, taxonomy.tagTypes, mode);
  if (!changed && !tagsChanged) return false;

  if (changed) {
    await db.prepare(
      `UPDATE draft_pages SET name = ?, slug = ?, weight = ?, start = ?, end = ?, lect = ? WHERE id = ?`,
    )
      .bind(name, slug, weight, start, end, lectValue, existing.id)
      .run();
    const versionId = await savePageVersion(db, existing.id, lectValue, 'import');
    await db.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
      .bind(versionId, existing.id)
      .run();
  }

  return true;
}

export async function importPagesCsv(
  db: D1Database,
  pageType: string,
  csvText: string,
  userId: number,
  mode: CsvImportMode = 'new-append',
  config: CmsConfig = cmsConfig,
): Promise<CsvImportResult> {
  const rows = csvRowsToObjects(parseCsv(csvText));
  const pathSpecs = csvPathSpecs([pageType], true, config);
  const taxonomy = await editorTaxonomy(db);
  const result: CsvImportResult = { created: 0, updated: 0, skipped: 0 };
  const importRows = rows.map((row, index) => ({ index, row })).filter(({ row }) => csvRowHasValues(row));
  const targets = mode === 'force-new' ? new Map<number, Page>() : await findImportTargets(db, pageType, importRows);
  const creations: PreparedImportedPage[] = [];
  const idBase = generatedImportIdBase();

  for (const [index, row] of rows.entries()) {
    if (!csvRowHasValues(row)) {
      result.skipped++;
      continue;
    }

    const existing = targets.get(index) ?? null;
    if (!existing) {
      if (mode === 'append' || mode === 'overwrite') {
        result.skipped++;
        continue;
      }
      creations.push(prepareImportedPage(pageType, row, userId, pathSpecs, idBase, creations.length, config));
      continue;
    }

    if (mode === 'new') {
      result.skipped++;
      continue;
    }

    const updateMode = mode === 'append' || mode === 'new-append' ? 'append' : 'replace';
    if (await updateImportedPage(db, pageType, row, existing, userId, taxonomy, pathSpecs, updateMode, config)) {
      result.updated++;
    } else {
      result.skipped++;
    }
  }

  if (creations.length) {
    await bulkCreateImportedPages(db, creations, taxonomy);
    result.created += creations.length;
  }

  return result;
}
