// CSV import workflows: legacy JSON import and the CSV preview/confirm (v2) flow.

import { Hono } from 'hono';
import { importPage } from '../../templates/import';
import { resolveCmsConfig } from '../../plugins/config';
import {
  blueprintToLect,
  getLectLocalizedValue,
  mergeLects,
  normalizeLect,
  stringifyLect,
} from '../../utils/lect';
import type { Lect, LectItem } from '../../utils/lect';
import type { Env, Variables } from '../../types';
import {
  csvImportMode,
  csvImportModeOptions,
  slugify,
  str,
  userIdFromContext,
} from '../../utils/forms';
import { withDraftMetadata } from '../../utils/page-logic';
import { editorTaxonomy, fetchUserAvatar } from '../../utils/admin-queries';
import {
  csvPathSpecs,
  exportHeaders,
  importPagesCsv,
  previewPagesCsv,
  readImportCsvText,
} from '../../utils/csv';
import { buildBaseProps } from '../../utils/admin-render';

export const importRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

importRoutes.get('/pages/import-v2/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const [userAvatar, taxonomy, config] = await Promise.all([
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    editorTaxonomy(c.env.DB),
    resolveCmsConfig(c.env),
  ]);

  return c.html(await importPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    pageType,
    mode: 'csv',
    action: `/admin/pages/import-v2/${encodeURIComponent(pageType)}`,
    sampleHeaders: exportHeaders(csvPathSpecs([pageType], false, config), taxonomy.tagTypes),
  }));
});

importRoutes.post('/pages/import-v2/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const csvText = await readImportCsvText(form);
  if (!csvText.trim()) {
    return c.redirect(`/admin/pages/list/${encodeURIComponent(pageType)}?flash=No+CSV+content+provided`);
  }

  const config = await resolveCmsConfig(c.env);
  const [userAvatar, preview] = await Promise.all([
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    previewPagesCsv(c.env.DB, pageType, csvText, config),
  ]);

  return c.html(await importPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    pageType,
    mode: 'confirm',
    action: `/admin/pages/import-v2/${encodeURIComponent(pageType)}/confirm`,
    csvText,
    previewRows: preview.rows,
    skippedCount: preview.skipped,
    importModeOptions: csvImportModeOptions(),
  }));
});

importRoutes.post('/pages/import-v2/:pageType/confirm', async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const csvText = str(form.get('csv'));
  const mode = csvImportMode(form.get('action'));
  if (!csvText.trim()) {
    return c.redirect(`/admin/pages/list/${encodeURIComponent(pageType)}?flash=No+CSV+content+provided`);
  }

  const config = await resolveCmsConfig(c.env);
  const result = await importPagesCsv(c.env.DB, pageType, csvText, userIdFromContext(c), mode, config);
  return c.redirect(
    `/admin/pages/list/${encodeURIComponent(pageType)}?flash=${result.created}+created,+${result.updated}+updated,+${result.skipped}+skipped`,
  );
});

importRoutes.get('/pages/import/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  return c.html(await importPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    pageType,
  }));
});

importRoutes.post('/pages/import/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const raw = str(form.get('items'));
  const creator = userIdFromContext(c) || null;
  const config = await resolveCmsConfig(c.env);
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
      mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), itemLect),
      userIdFromContext(c),
    );
    lect._type = pageType;
    const name = item.name ?? (getLectLocalizedValue(lect, 'name', config.defaultLanguage) || 'Untitled');
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
