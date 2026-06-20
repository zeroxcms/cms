// Database-defined page type management (full CRUD). Config-file page types
// are shown read-only alongside the editable database ones. The merge into the
// effective CmsConfig happens in resolveCmsConfig() — see page-type-store.ts.

import { Hono } from 'hono';
import { pageTypeFormPage, pageTypesPage } from '../../templates/page-types';
import { cmsConfig } from '../../cms-config';
import type { Env, Variables, PageType } from '../../types';
import { num, slugify, str, userIdFromContext } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { fetchUserAvatar } from '../../utils/admin-queries';
import { buildBaseProps } from '../../utils/admin-render';
import { listDbPageTypes } from '../../utils/page-type-store';
import type { AppContext } from '../../utils/context';

export const pageTypesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interface PageTypeFormValues {
  name: string;
  slug: string;
  blueprint: string;
  blocks: string;
  blockLists: string;
  tagLists: string;
  weight: string;
}

function formValues(form: FormData): PageTypeFormValues {
  return {
    name: str(form.get('name')),
    slug: str(form.get('slug')),
    blueprint: str(form.get('blueprint')),
    blocks: str(form.get('blocks')),
    blockLists: str(form.get('block_lists')),
    tagLists: str(form.get('tag_lists')),
    weight: str(form.get('weight')),
  };
}

/** Validates a form submission; returns an error message or null. `ignoreId`
 *  skips the row being edited during the slug-collision check. */
async function validate(c: AppContext, values: PageTypeFormValues, slug: string, ignoreId?: number): Promise<string | null> {
  if (!values.name) return 'Name is required.';
  if (!slug) return 'Slug is required.';
  if (slug in cmsConfig.blueprint) return `Slug "${slug}" is already defined in the config file.`;

  const existing = await c.env.DB.prepare('SELECT id FROM page_types WHERE slug = ?')
    .bind(slug)
    .first<{ id: number }>();
  if (existing && existing.id !== ignoreId) return `Slug "${slug}" is already in use.`;

  // blueprint must be a JSON array; the optional fragments must parse if present.
  try {
    const blueprint = JSON.parse(values.blueprint || '[]');
    if (!Array.isArray(blueprint)) return 'Blueprint must be a JSON array.';
  } catch {
    return 'Blueprint is not valid JSON.';
  }
  for (const [label, raw] of [['Blocks', values.blocks], ['Block lists', values.blockLists], ['Tag lists', values.tagLists]] as const) {
    if (!raw.trim()) continue;
    try {
      JSON.parse(raw);
    } catch {
      return `${label} is not valid JSON.`;
    }
  }
  return null;
}

function nullableJson(raw: string): string | null {
  return raw.trim() ? raw.trim() : null;
}

// ── List ────────────────────────────────────────────────────────────────────

pageTypesRoutes.get('/page_types', async (c) => {
  const [dbPageTypes, userAvatar] = await Promise.all([
    listDbPageTypes(c.env.DB),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);
  const dbSlugs = new Set(dbPageTypes.map((pageType) => pageType.slug));
  const configPageTypes = Object.keys(cmsConfig.blueprint)
    .filter((slug) => !dbSlugs.has(slug))
    .map((slug) => ({ slug, name: slug }));

  return c.html(await pageTypesPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    dbPageTypes,
    configPageTypes,
  }));
});

// ── Create ──────────────────────────────────────────────────────────────────

pageTypesRoutes.get('/page_types/new', async (c) => pageTypeForm(c));

pageTypesRoutes.post('/page_types', requirePermission('pagetype:write'), async (c) => {
  const form = await c.req.formData();
  const values = formValues(form);
  const slug = values.slug ? slugify(values.slug) : slugify(values.name);

  const error = await validate(c, values, slug);
  if (error) return pageTypeForm(c, undefined, error, values);

  const result = await c.env.DB.prepare(
    `INSERT INTO page_types (slug, name, blueprint, blocks, block_lists, tag_lists, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slug,
      values.name,
      values.blueprint || '[]',
      nullableJson(values.blocks),
      nullableJson(values.blockLists),
      nullableJson(values.tagLists),
      num(values.weight),
    )
    .run();
  logAudit(c, 'page_type.create', 'page_type', result.meta.last_row_id, { slug, name: values.name });
  return c.redirect('/admin/page_types');
});

// ── Edit ────────────────────────────────────────────────────────────────────

pageTypesRoutes.get('/page_types/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const pageType = await c.env.DB.prepare('SELECT * FROM page_types WHERE id = ?')
    .bind(id)
    .first<PageType>();
  if (!pageType) return c.notFound();
  return pageTypeForm(c, pageType);
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
  if (error) return pageTypeForm(c, existing, error, values);

  await c.env.DB.prepare(
    `UPDATE page_types
        SET slug = ?, name = ?, blueprint = ?, blocks = ?, block_lists = ?, tag_lists = ?, weight = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  )
    .bind(
      slug,
      values.name,
      values.blueprint || '[]',
      nullableJson(values.blocks),
      nullableJson(values.blockLists),
      nullableJson(values.tagLists),
      num(values.weight),
      id,
    )
    .run();
  logAudit(c, 'page_type.update', 'page_type', id, { slug, name: values.name });
  return c.redirect('/admin/page_types');
});

pageTypesRoutes.post('/page_types/:id/delete', requirePermission('pagetype:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM page_types WHERE id = ?').bind(id).run();
  logAudit(c, 'page_type.delete', 'page_type', id);
  return c.redirect('/admin/page_types');
});

// ── Shared form renderer ──────────────────────────────────────────────────────

async function pageTypeForm(c: AppContext, pageType?: PageType, error?: string, values?: PageTypeFormValues): Promise<Response> {
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  return c.html(await pageTypeFormPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    pageType,
    error,
    values,
  }));
}
