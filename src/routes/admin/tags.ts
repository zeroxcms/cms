// Tag and tag-type management.

import { Hono } from 'hono';
import { tagTypeFormPage, tagTypesPage } from '../../templates/tag-types';
import { tagFormPage, tagsPage } from '../../templates/tags';
import { cmsConfig } from '../../cms-config';
import {
  getLectLocalizedValue,
  mergeLects,
  postToLect,
  safeParseLect,
  stringifyLect,
} from '../../utils/lect';
import type { Env, Variables, Tag, TagType } from '../../types';
import {
  languageFromRequest,
  nullableStr,
  num,
  slugify,
  str,
  userIdFromContext,
} from '../../utils/forms';
import { ensureDefaultLectName } from '../../utils/page-logic';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { fetchUserAvatar } from '../../utils/admin-queries';
import { buildBaseProps } from '../../utils/admin-render';
import type { AppContext } from '../../utils/context';

export const tagsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Tag types ─────────────────────────────────────────────────────────────────

tagsRoutes.get('/tag-types', async (c) => {
  const [tagTypes, userAvatar] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);

  return c.html(await tagTypesPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    tagTypes: tagTypes.results,
  }));
});

tagsRoutes.get('/tag-types/new', async (c) => tagTypeForm(c));

tagsRoutes.post('/tag-types', requirePermission('taxonomy:write'), async (c) => {
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  if (!name || !slug) return c.redirect('/admin/tag-types/new?error=missing');
  const result = await c.env.DB.prepare('INSERT INTO tag_types (name, slug) VALUES (?, ?)')
    .bind(name, slug)
    .run();
  logAudit(c, 'tag_type.create', 'tag_type', result.meta.last_row_id, { name, slug });
  return c.redirect('/admin/tag-types');
});

tagsRoutes.get('/tag-types/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tagType = await c.env.DB.prepare('SELECT * FROM tag_types WHERE id = ?')
    .bind(id)
    .first<TagType>();
  if (!tagType) return c.notFound();
  return tagTypeForm(c, tagType);
});

tagsRoutes.post('/tag-types/:id', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  await c.env.DB.prepare('UPDATE tag_types SET name = ?, slug = ? WHERE id = ?')
    .bind(name, slug, id)
    .run();
  logAudit(c, 'tag_type.update', 'tag_type', id, { name, slug });
  return c.redirect('/admin/tag-types');
});

tagsRoutes.post('/tag-types/:id/delete', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('UPDATE tags SET tag_type_id = NULL WHERE tag_type_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM tag_types WHERE id = ?').bind(id).run();
  logAudit(c, 'tag_type.delete', 'tag_type', id);
  return c.redirect('/admin/tag-types');
});

// ── Tags ─────────────────────────────────────────────────────────────────────

tagsRoutes.get('/tags', async (c) => {
  const filterTagType = parseInt(c.req.query('filter_tag_type') ?? '0', 10);
  const [tagTypes, tags, userAvatar] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
    filterTagType
      ? c.env.DB.prepare('SELECT * FROM tags WHERE tag_type_id = ? ORDER BY name ASC').bind(filterTagType).all<Tag>()
      : c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);
  return c.html(await tagsPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    tagTypes: tagTypes.results,
    tags: tags.results,
    filterTagType,
  }));
});

tagsRoutes.get('/tags/new', async (c) => tagForm(c));

tagsRoutes.post('/tags', requirePermission('taxonomy:write'), async (c) => {
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const name = str(form.get('name'));
  const slug = str(form.get('slug')) || slugify(name);
  const lect = postToLect(form, language);
  ensureDefaultLectName(lect, name);
  const result = await c.env.DB.prepare(
    'INSERT INTO tags (name, slug, tag_type_id, parent_tag, lect) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(name, slug, nullableStr(form.get('tag_type_id')) ? num(form.get('tag_type_id')) : null, nullableStr(form.get('parent_tag')) ? num(form.get('parent_tag')) : null, stringifyLect(lect))
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

tagsRoutes.post('/tags/:id', requirePermission('taxonomy:write'), async (c) => {
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
  logAudit(c, 'tag.update', 'tag', id, { name, slug });
  return c.redirect('/admin/tags');
});

tagsRoutes.post('/tags/:id/delete', requirePermission('taxonomy:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await Promise.all([
    c.env.DB.prepare('DELETE FROM draft_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.PUBLISHED_DB.prepare('DELETE FROM live_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.DB.prepare('DELETE FROM trash_page_tags WHERE tag_id = ?').bind(id).run(),
    c.env.DB.prepare('UPDATE tags SET parent_tag = NULL WHERE parent_tag = ?').bind(id).run(),
  ]);
  await c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
  logAudit(c, 'tag.delete', 'tag', id);
  return c.redirect('/admin/tags');
});

async function tagTypeForm(c: AppContext, tagType?: TagType) {
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  return c.html(await tagTypeFormPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    tagType,
  }));
}

async function tagForm(c: AppContext, tag?: Tag) {
  const language = languageFromRequest(c);
  const [tagTypes, tags, userAvatar] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
    c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);
  const lect = safeParseLect(tag?.lect);
  const rawTranslatedName = getLectLocalizedValue(lect, 'name', language);
  const translatedName = language === cmsConfig.defaultLanguage ? rawTranslatedName || tag?.name || '' : rawTranslatedName;
  const defaultTranslatedName = getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage) || tag?.name || '';
  const translatedPlaceholder = language === cmsConfig.defaultLanguage ? '' : defaultTranslatedName;
  return c.html(await tagFormPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    tag,
    language,
    languages: cmsConfig.languages,
    translatedName,
    translatedPlaceholder,
    tagTypes: tagTypes.results,
    parentTags: tags.results,
  }));
}
