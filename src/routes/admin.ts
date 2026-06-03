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
import { dashboardPage } from '../templates/dashboard';
import { editorPage } from '../templates/editor';
import { importPage } from '../templates/import';
import { tagTypeFormPage, tagTypesPage } from '../templates/tag-types';
import { tagFormPage, tagsPage } from '../templates/tags';
import { trashPage } from '../templates/trash';
import { cmsConfig } from '../cms-config';
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

// Apply auth to all admin routes
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', editorGuard);

// ── Helper: parse form data safely ────────────────────────────────────────────

// FormDataEntryValue is File | string in the Fetch API
type FormValue = File | string | null | undefined;

function str(v: FormValue): string {
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
    }),
  );
});

// ── Page type workflows ──────────────────────────────────────────────────────

adminRoutes.get('/pages/list/:pageType', async (c) => {
  const user = c.get('user');
  const pageType = c.req.param('pageType');
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';

  const draftPages = search
    ? await c.env.DB.prepare(
        'SELECT * FROM draft_pages WHERE page_type = ? AND name LIKE ? ORDER BY weight ASC, name ASC',
      )
        .bind(pageType, `%${search}%`)
        .all<Page>()
    : await c.env.DB.prepare(
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
      returnPath: `/admin/pages/list/${encodeURIComponent(pageType)}${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    }),
  );
});

adminRoutes.get('/pages/search/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const search = c.req.query('search') ?? '';
  return c.redirect(`/admin/pages/list/${encodeURIComponent(pageType)}?search=${encodeURIComponent(search)}`);
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

  const [page, parentPages, taxonomy, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>(),
    c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
    editorTaxonomy(c.env.DB),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  if (!page) return c.notFound();

  const [version, versions, pageTags] = await Promise.all([
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
      parentPages: parentPages.results,
      tags: taxonomy.tags,
      tagTypes: taxonomy.tagTypes,
      selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
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
    const [parentPages, taxonomy, version, versions, pageTags, dbUser] = await Promise.all([
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
