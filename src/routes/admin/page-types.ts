// Database-defined page type management (full CRUD). Config-file page types
// are shown read-only alongside the editable database ones. The merge into the
// effective CmsConfig happens in resolveCmsConfig() — see page-type-store.ts.

import { Hono } from 'hono';
import { pageTypeFormPage, pageTypesPage } from '../../templates/page-types';
import type { PageTypeFormModel } from '../../templates/page-types';
import { cmsConfig } from '../../cms-config';
import type { Env, Variables, PageType } from '../../types';
import { num, slugify, str } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { renderPage, userCan } from '../../utils/admin-render';
import { clearConfigCache, resolveCmsConfig } from '../../plugins/config';
import { getPlugins } from '../../plugins/registry';
import { listDbPageTypes } from '../../utils/page-type-store';
import { configOnlyTypes, validateTypeForm } from '../../utils/type-admin';
import type { AppContext } from '../../utils/context';

export const pageTypesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interface PageTypeFormValues {
  name: string;
  slug: string;
  blueprint: string;
  blockLists: string[];
  taxonomyLists: string[];
  weight: string;
}

function formValues(form: FormData): PageTypeFormValues {
  return {
    name: str(form.get('name')),
    slug: str(form.get('slug')),
    blueprint: str(form.get('blueprint')),
    blockLists: form.getAll('block_lists').map(String),
    taxonomyLists: form.getAll('taxonomy_lists').map(String),
    weight: str(form.get('weight')),
  };
}

/** Parses a stored JSON string array, tolerating null/malformed values. */
function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function validate(c: AppContext, values: PageTypeFormValues, slug: string, ignoreId?: number): Promise<string | null> {
  return validateTypeForm(c, {
    name: values.name,
    slug,
    blueprint: values.blueprint,
    table: 'page_types',
    configSlugs: cmsConfig.blueprint,
    ignoreId,
  });
}

function nullableJsonArray(values: string[]): string | null {
  return values.length ? JSON.stringify(values) : null;
}

// ── List ────────────────────────────────────────────────────────────────────

pageTypesRoutes.get('/page_types', async (c) => {
  const [dbPageTypes, plugins] = await Promise.all([
    listDbPageTypes(c.env.DB),
    getPlugins(c.env),
  ]);
  const resolved = await resolveCmsConfig(c.env);
  const dbSlugs = new Set(dbPageTypes.map((pageType) => pageType.slug));
  const configPageTypes = configOnlyTypes(
    Object.keys(resolved.blueprint),
    dbSlugs,
    plugins,
    (plugin) => plugin.manifest.contentTypes?.blueprint,
  );

  return renderPage(c, pageTypesPage, {
    dbPageTypes,
    configPageTypes,
    canWrite: await userCan(c, 'pagetype:write'),
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

pageTypesRoutes.get('/page_types/new', async (c) => {
  if (!(await userCan(c, 'pagetype:write'))) return c.redirect('/admin/page_types');
  return renderForm(c, {
    mode: 'new',
    name: '',
    slug: '',
    weight: '5',
    blueprint: '[]',
    selectedBlocks: [],
    selectedTaxonomies: [],
  });
});

pageTypesRoutes.post('/page_types', requirePermission('pagetype:write'), async (c) => {
  const form = await c.req.formData();
  const values = formValues(form);
  const slug = values.slug ? slugify(values.slug) : slugify(values.name);

  const error = await validate(c, values, slug);
  if (error) return renderForm(c, modelFromValues('new', values, error));

  const result = await c.env.DB.prepare(
    `INSERT INTO page_types (slug, name, blueprint, block_lists, taxonomy_lists, weight)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slug,
      values.name,
      values.blueprint || '[]',
      nullableJsonArray(values.blockLists),
      nullableJsonArray(values.taxonomyLists),
      num(values.weight),
    )
    .run();
  clearConfigCache();
  logAudit(c, 'page_type.create', 'page_type', result.meta.last_row_id, { slug, name: values.name });
  return c.redirect('/admin/page_types');
});

// ── View (read-only, config-file page types) ──────────────────────────────────

pageTypesRoutes.get('/page_types/view/:slug', async (c) => {
  const slug = c.req.param('slug');
  // Resolve so plugin-contributed blueprints are viewable too, not just config-file ones.
  const config = await resolveCmsConfig(c.env);
  const blueprint = config.blueprint[slug];
  if (!blueprint) return c.notFound();
  return renderForm(c, {
    mode: 'view',
    name: slug,
    slug,
    weight: '',
    blueprint: JSON.stringify(blueprint, null, 2),
    selectedBlocks: config.blockLists[slug] ?? [],
    selectedTaxonomies: config.taxonomyLists[slug] ?? [],
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

pageTypesRoutes.get('/page_types/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const pageType = await c.env.DB.prepare('SELECT * FROM page_types WHERE id = ?')
    .bind(id)
    .first<PageType>();
  if (!pageType) return c.notFound();
  const mode = (await userCan(c, 'pagetype:write')) ? 'edit' : 'view';
  return renderForm(c, modelFromRow(mode, pageType));
});

pageTypesRoutes.post('/page_types/:id', requirePermission('pagetype:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = await c.env.DB.prepare('SELECT * FROM page_types WHERE id = ?')
    .bind(id)
    .first<PageType>();
  if (!existing) return c.notFound();

  const form = await c.req.formData();
  const values = formValues(form);
  const slug = values.slug ? slugify(values.slug) : slugify(values.name);

  const error = await validate(c, values, slug, id);
  if (error) return renderForm(c, { ...modelFromValues('edit', values, error), id });

  await c.env.DB.prepare(
    `UPDATE page_types
        SET slug = ?, name = ?, blueprint = ?, block_lists = ?, taxonomy_lists = ?, weight = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  )
    .bind(
      slug,
      values.name,
      values.blueprint || '[]',
      nullableJsonArray(values.blockLists),
      nullableJsonArray(values.taxonomyLists),
      num(values.weight),
      id,
    )
    .run();
  clearConfigCache();
  logAudit(c, 'page_type.update', 'page_type', id, { slug, name: values.name });
  return c.redirect('/admin/page_types');
});

pageTypesRoutes.post('/page_types/:id/delete', requirePermission('pagetype:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM page_types WHERE id = ?').bind(id).run();
  clearConfigCache();
  logAudit(c, 'page_type.delete', 'page_type', id);
  return c.redirect('/admin/page_types');
});

// ── Shared form rendering ─────────────────────────────────────────────────────

type FormModel = Omit<PageTypeFormModel, 'availableBlocks' | 'availableTaxonomies'>;

function modelFromRow(mode: 'edit' | 'view', row: PageType): FormModel {
  return {
    mode,
    id: row.id,
    name: row.name,
    slug: row.slug,
    weight: String(row.weight),
    blueprint: row.blueprint,
    selectedBlocks: parseStringArray(row.block_lists),
    selectedTaxonomies: parseStringArray(row.taxonomy_lists),
  };
}

function modelFromValues(mode: 'new' | 'edit', values: PageTypeFormValues, error: string): FormModel {
  return {
    mode,
    error,
    name: values.name,
    slug: values.slug,
    weight: values.weight,
    blueprint: values.blueprint,
    selectedBlocks: values.blockLists,
    selectedTaxonomies: values.taxonomyLists,
  };
}

async function renderForm(c: AppContext, model: FormModel): Promise<Response> {
  const [config, taxonomies] = await Promise.all([
    resolveCmsConfig(c.env),
    c.env.DB.prepare('SELECT slug, name FROM taxonomies ORDER BY name ASC').all<{ slug: string; name: string }>(),
  ]);
  return renderPage(c, pageTypeFormPage, {
    ...model,
    availableBlocks: Object.keys(config.blocks),
    availableTaxonomies: taxonomies.results,
  });
}
