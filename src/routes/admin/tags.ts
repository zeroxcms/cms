// Tag and taxonomy management.

import { Hono } from 'hono';
import { taxonomyFormPage, taxonomiesPage } from '../../templates/taxonomies';
import { tagFormPage, tagsPage } from '../../templates/tags';
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
import { ensureDefaultLectName } from '../../utils/page-logic';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { removeTagFromTargets } from '../../publish';
import { renderPage, userCan } from '../../utils/admin-render';
import type { AppContext } from '../../utils/context';

export const tagsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Tag types ─────────────────────────────────────────────────────────────────

tagsRoutes.get('/taxonomies', async (c) => {
  const taxonomies = await c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>();

  return renderPage(c, taxonomiesPage, {
    taxonomies: taxonomies.results,
    canWrite: await userCan(c, 'taxonomy:write'),
  });
});

tagsRoutes.get('/taxonomies/new', async (c) => {
  if (!(await userCan(c, 'taxonomy:write'))) return c.redirect('/admin/taxonomies');
  return taxonomyForm(c);
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
  await c.env.DB.prepare('UPDATE taxonomies SET name = ?, slug = ? WHERE id = ?')
    .bind(name, slug, id)
    .run();
  logAudit(c, 'taxonomy.update', 'taxonomy', id, { name, slug });
  return c.redirect('/admin/taxonomies');
});

tagsRoutes.post('/taxonomies/:id/delete', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('UPDATE tags SET taxonomy_id = NULL WHERE taxonomy_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM taxonomies WHERE id = ?').bind(id).run();
  logAudit(c, 'taxonomy.delete', 'taxonomy', id);
  return c.redirect('/admin/taxonomies');
});

// ── Tags ─────────────────────────────────────────────────────────────────────

tagsRoutes.get('/tags', async (c) => {
  const filterTaxonomy = parseInt(c.req.query('filter_taxonomy') ?? '0', 10);
  const [taxonomies, tags] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
    filterTaxonomy
      ? c.env.DB.prepare('SELECT * FROM tags WHERE taxonomy_id = ? ORDER BY name ASC').bind(filterTaxonomy).all<Tag>()
      : c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
  ]);
  return renderPage(c, tagsPage, {
    taxonomies: taxonomies.results,
    tags: tags.results,
    filterTaxonomy,
  });
});

tagsRoutes.get('/tags/new', async (c) => tagForm(c));

tagsRoutes.post('/tags', requirePermission('tag:write'), async (c) => {
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const lect = postToLect(form, language);
  ensureDefaultLectName(lect, name);
  const result = await c.env.DB.prepare(
    'INSERT INTO tags (name, slug, taxonomy_id, parent_tag, lect) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(name, slug, nullableStr(form.get('taxonomy_id')) ? num(form.get('taxonomy_id')) : null, nullableStr(form.get('parent_tag')) ? num(form.get('parent_tag')) : null, stringifyLect(lect))
    .run();
  logAudit(c, 'tag.create', 'tag', result.meta.last_row_id, { name, slug });
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
  const language = languageFromRequest(c, form);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const existing = await c.env.DB.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first<Tag>();
  if (!existing) return c.notFound();
  const lect = mergeLects(safeParseLect(existing.lect), postToLect(form, language));
  ensureDefaultLectName(lect, name);
  await c.env.DB.prepare(
    'UPDATE tags SET name = ?, slug = ?, taxonomy_id = ?, parent_tag = ?, lect = ? WHERE id = ?',
  )
    .bind(name, slug, nullableStr(form.get('taxonomy_id')) ? num(form.get('taxonomy_id')) : null, nullableStr(form.get('parent_tag')) ? num(form.get('parent_tag')) : null, stringifyLect(lect), id)
    .run();
  logAudit(c, 'tag.update', 'tag', id, { name, slug });
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

async function taxonomyForm(c: AppContext, taxonomy?: Taxonomy, readOnly = false) {
  return renderPage(c, taxonomyFormPage, {
    taxonomy,
    readOnly,
  });
}

async function tagForm(c: AppContext, tag?: Tag) {
  const language = languageFromRequest(c);
  const [taxonomies, tags] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
    c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
  ]);
  const lect = safeParseLect(tag?.lect);
  const rawTranslatedName = getLectLocalizedValue(lect, 'name', language);
  const translatedName = language === cmsConfig.defaultLanguage ? rawTranslatedName || tag?.name || '' : rawTranslatedName;
  const defaultTranslatedName = getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || tag?.name || '';
  const translatedPlaceholder = language === cmsConfig.defaultLanguage ? '' : defaultTranslatedName;
  return renderPage(c, tagFormPage, {
    tag,
    language,
    languages: cmsConfig.languages,
    translatedName,
    translatedPlaceholder,
    taxonomies: taxonomies.results,
    parentTags: tags.results,
  });
}
