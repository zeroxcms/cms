// Tag and taxonomy management.

import { Hono } from 'hono';
import { taxonomyFormPage, taxonomiesPage } from '../../templates/taxonomies';
import type { TaxonomyFormData } from '../../templates/taxonomies';
import { tagFormPage, tagsPage } from '../../templates/tags';
import type { TagTaxonomyOption } from '../../templates/tags';
import { cmsConfig } from '../../cms-config';
import {
  getLectLocalizedValue,
  mergeLects,
  postToLect,
  safeParseLect,
  stringifyLect,
} from '../../utils/lect';
import type { Env, Variables, Tag, Taxonomy } from '../../types';
import {
  languageFromRequest,
  nullableStr,
  num,
  slugify,
  str,
} from '../../utils/forms';
import type { FormValue } from '../../utils/forms';
import { ensureDefaultLectName } from '../../utils/page-logic';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { removeTagFromTargets } from '../../publish';
import { renderPage, userCan } from '../../utils/admin-render';
import { resolveCmsConfig } from '../../plugins/config';
import { getPlugins } from '../../plugins/registry';
import { configOnlyTypes } from '../../utils/type-admin';
import type { AppContext } from '../../utils/context';

export const tagsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Tag types ─────────────────────────────────────────────────────────────────

tagsRoutes.get('/taxonomies', async (c) => {
  const [dbTaxonomies, plugins, config] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
    getPlugins(c.env),
    resolveCmsConfig(c.env),
  ]);
  const dbSlugs = new Set(dbTaxonomies.results.map((taxonomy) => taxonomy.slug));
  const configTaxonomies = configOnlyTypes(
    Object.keys(config.taxonomies),
    dbSlugs,
    plugins,
    (plugin) => plugin.manifest.contentTypes?.taxonomies,
  ).map((taxonomy) => ({
    ...taxonomy,
    name: config.taxonomies[taxonomy.slug] ?? taxonomy.name,
  }));

  return renderPage(c, taxonomiesPage, {
    dbTaxonomies: dbTaxonomies.results,
    configTaxonomies,
    canWrite: await userCan(c, 'taxonomy:write'),
  });
});

tagsRoutes.get('/taxonomies/new', async (c) => {
  if (!(await userCan(c, 'taxonomy:write'))) return c.redirect('/admin/taxonomies');
  return taxonomyForm(c);
});

tagsRoutes.get('/taxonomies/view/:slug', async (c) => {
  const slug = c.req.param('slug');
  const config = await resolveCmsConfig(c.env);
  const name = config.taxonomies[slug];
  if (!name) return c.notFound();
  return taxonomyForm(c, { name, slug }, true);
});

tagsRoutes.post('/taxonomies', requirePermission('taxonomy:write'), async (c) => {
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  if (!name || !slug) return c.redirect('/admin/taxonomies/new?error=missing');
  const result = await c.env.DB.prepare('INSERT INTO taxonomies (name, slug) VALUES (?, ?)')
    .bind(name, slug)
    .run();
  logAudit(c, 'taxonomy.create', 'taxonomy', result.meta.last_row_id, { name, slug });
  return c.redirect('/admin/taxonomies');
});

tagsRoutes.get('/taxonomies/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const taxonomy = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE id = ?')
    .bind(id)
    .first<Taxonomy>();
  if (!taxonomy) return c.notFound();
  return taxonomyForm(c, taxonomy, !(await userCan(c, 'taxonomy:write')));
});

tagsRoutes.post('/taxonomies/:id', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const existing = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE id = ?')
    .bind(id)
    .first<Taxonomy>();
  if (!existing) return c.notFound();
  await c.env.DB.prepare('UPDATE taxonomies SET name = ?, slug = ? WHERE id = ?')
    .bind(name, slug, id)
    .run();
  if (existing.slug !== slug) {
    await c.env.DB.prepare('UPDATE tags SET taxonomy_slug = ? WHERE taxonomy_slug = ?')
      .bind(slug, existing.slug)
      .run();
  }
  logAudit(c, 'taxonomy.update', 'taxonomy', id, { name, slug });
  return c.redirect('/admin/taxonomies');
});

tagsRoutes.post('/taxonomies/:id/delete', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const taxonomy = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE id = ?')
    .bind(id)
    .first<Taxonomy>();
  if (!taxonomy) return c.notFound();
  await c.env.DB.prepare('UPDATE tags SET taxonomy_slug = NULL WHERE taxonomy_slug = ?').bind(taxonomy.slug).run();
  await c.env.DB.prepare('DELETE FROM taxonomies WHERE id = ?').bind(id).run();
  logAudit(c, 'taxonomy.delete', 'taxonomy', id);
  return c.redirect('/admin/taxonomies');
});

// ── Tags ─────────────────────────────────────────────────────────────────────

tagsRoutes.get('/tags', async (c) => {
  const filterTaxonomy = str(c.req.query('filter_taxonomy'));
  const [taxonomies, tags] = await Promise.all([
    tagTaxonomyOptions(c),
    listTags(c.env.DB, filterTaxonomy),
  ]);
  return renderPage(c, tagsPage, {
    taxonomies,
    tags,
    filterTaxonomy,
  });
});

tagsRoutes.get('/tags/new', async (c) => tagForm(c));

tagsRoutes.post('/tags/batch-weight', requirePermission('tag:write'), async (c) => {
  const body = await c.req.json<{ updates: { id: number; weight: number }[] }>();
  const { updates } = body;

  if (!Array.isArray(updates)) return c.json({ error: 'Invalid input' }, 400);

  const statements = [];
  for (const update of updates) {
    const id = Number(update?.id);
    const weight = Number(update?.weight);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(weight)) {
      return c.json({ error: 'Invalid input' }, 400);
    }
    statements.push(c.env.DB.prepare('UPDATE tags SET weight = ? WHERE id = ?').bind(weight, id));
  }

  if (!statements.length) return c.json({ success: true });

  const results = await c.env.DB.batch(statements);
  if (results.some((r) => !r.success)) {
    return c.json({ error: 'Some updates failed' }, 500);
  }

  return c.json({ success: true });
});

tagsRoutes.post('/tags', requirePermission('tag:write'), async (c) => {
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const weight = num(form.get('weight'), 5);
  const lect = postToLect(form, language);
  ensureDefaultLectName(lect, name);
  const taxonomySlug = nullableStr(form.get('taxonomy_slug'));
  const parentTagId = optionalNumericId(form.get('parent_tag'));
  const result = await c.env.DB.prepare(
    'INSERT INTO tags (name, slug, weight, taxonomy_slug, parent_tag, lect) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(name, slug, weight, taxonomySlug, parentTagId, stringifyLect(lect))
    .run();
  logAudit(c, 'tag.create', 'tag', result.meta.last_row_id, { name, slug, weight, taxonomySlug });
  return c.redirect('/admin/tags');
});

tagsRoutes.get('/tags/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tag = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!tag) return c.notFound();
  return tagForm(c, tag);
});

tagsRoutes.post('/tags/:id', requirePermission('tag:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const weight = num(form.get('weight'), 5);
  const existing = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!existing) return c.notFound();
  const lect = mergeLects(safeParseLect(existing.lect), postToLect(form, language));
  ensureDefaultLectName(lect, name);
  const taxonomySlug = nullableStr(form.get('taxonomy_slug'));
  const parentTagId = optionalNumericId(form.get('parent_tag'));
  await c.env.DB.prepare(
    'UPDATE tags SET name = ?, slug = ?, weight = ?, taxonomy_slug = ?, parent_tag = ?, lect = ? WHERE id = ?',
  )
    .bind(name, slug, weight, taxonomySlug, parentTagId, stringifyLect(lect), id)
    .run();
  logAudit(c, 'tag.update', 'tag', id, { name, slug, weight, taxonomySlug });
  return c.redirect('/admin/tags');
});

tagsRoutes.post('/tags/:id/delete', requirePermission('tag:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await Promise.all([
    c.env.DB.prepare('DELETE FROM draft_page_tags WHERE tag_id = ?').bind(id).run(),
    removeTagFromTargets(c.env, id),
    c.env.DB.prepare('DELETE FROM trash_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.DB.prepare('UPDATE tags SET parent_tag = NULL WHERE parent_tag = ?').bind(id).run(),
  ]);
  await c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
  logAudit(c, 'tag.delete', 'tag', id);
  return c.redirect('/admin/tags');
});

async function taxonomyForm(c: AppContext, taxonomy?: TaxonomyFormData, readOnly = false) {
  return renderPage(c, taxonomyFormPage, {
    taxonomy,
    readOnly,
  });
}

interface TagSchema {
  hasTaxonomySlug: boolean;
  hasWeight: boolean;
}

async function tagSchema(db: D1DatabaseClient): Promise<TagSchema> {
  const columns = await db.prepare('PRAGMA table_info(tags)').all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  return {
    hasTaxonomySlug: names.has('taxonomy_slug'),
    hasWeight: names.has('weight'),
  };
}

async function listTags(db: D1DatabaseClient, filterTaxonomy = ''): Promise<Tag[]> {
  const schema = await tagSchema(db);
  const weightExpr = schema.hasWeight ? 'tags.weight' : '5';
  const taxonomyExpr = schema.hasTaxonomySlug ? 'tags.taxonomy_slug' : 'taxonomies.slug';
  const taxonomyJoin = schema.hasTaxonomySlug ? '' : ' LEFT JOIN taxonomies ON taxonomies.id = tags.taxonomy_id';
  const select = `SELECT tags.id, tags.uuid, tags.created_at, tags.updated_at, tags.name, tags.slug,
    ${weightExpr} AS weight, ${taxonomyExpr} AS taxonomy_slug, tags.parent_tag, tags.lect
    FROM tags${taxonomyJoin}`;

  if (filterTaxonomy) {
    return (await db.prepare(`${select} WHERE ${taxonomyExpr} = ? ORDER BY weight ASC, name ASC`)
      .bind(filterTaxonomy)
      .all<Tag>()).results;
  }
  return (await db.prepare(`${select} ORDER BY weight ASC, name ASC`).all<Tag>()).results;
}

function optionalNumericId(value: FormValue): number | null {
  const raw = nullableStr(value);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = num(raw, 0);
  return id > 0 ? id : null;
}

async function tagTaxonomyOptions(c: AppContext): Promise<TagTaxonomyOption[]> {
  const [dbTaxonomies, plugins, config] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
    getPlugins(c.env),
    resolveCmsConfig(c.env),
  ]);
  const dbSlugs = new Set(dbTaxonomies.results.map((taxonomy) => taxonomy.slug));
  const configTaxonomies = configOnlyTypes(
    Object.keys(config.taxonomies),
    dbSlugs,
    plugins,
    (plugin) => plugin.manifest.contentTypes?.taxonomies,
  ).map((taxonomy) => ({
    id: taxonomy.slug,
    name: config.taxonomies[taxonomy.slug] ?? taxonomy.name,
    sourceLabel: taxonomy.source === 'plugin'
      ? `plugin${taxonomy.pluginName ? `: ${taxonomy.pluginName}` : ''}`
      : 'config',
  }));

  return [
    ...dbTaxonomies.results.map((taxonomy) => ({
      id: taxonomy.slug,
      name: taxonomy.name,
    })),
    ...configTaxonomies,
  ].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function tagForm(c: AppContext, tag?: Tag) {
  const [taxonomies, tags, config] = await Promise.all([
    tagTaxonomyOptions(c),
    listTags(c.env.DB),
    resolveCmsConfig(c.env),
  ]);
  const language = languageFromRequest(c, undefined, config);
  const lect = safeParseLect(tag?.lect);
  const rawTranslatedName = getLectLocalizedValue(lect, 'name', language);
  const translatedName = language === cmsConfig.defaultLanguage ? rawTranslatedName || tag?.name || '' : rawTranslatedName;
  const defaultTranslatedName = getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || tag?.name || '';
  const translatedPlaceholder = language === cmsConfig.defaultLanguage ? '' : defaultTranslatedName;
  return renderPage(c, tagFormPage, {
    tag,
    language,
    languages: config.languages,
    translatedName,
    translatedPlaceholder,
    taxonomies,
    parentTags: tags,
  });
}
