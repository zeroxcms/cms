// Database-defined block type management (full CRUD). Config-file blocks are
// shown read-only alongside the editable database ones. The merge into the
// effective CmsConfig happens in resolveCmsConfig() — see block-type-store.ts.

import { Hono } from 'hono';
import { blockTypeFormPage, blockTypesPage } from '../../templates/block-types';
import type { BlockTypeFormModel } from '../../templates/block-types';
import { cmsConfig } from '../../cms-config';
import type { Env, Variables, BlockType } from '../../types';
import { num, slugify, str } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { renderPage, userCan } from '../../utils/admin-render';
import { clearConfigCache, resolveCmsConfig } from '../../plugins/config';
import { getPlugins } from '../../plugins/registry';
import { listDbBlockTypes } from '../../utils/block-type-store';
import type { AppContext } from '../../utils/context';

export const blockTypesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interface BlockTypeFormValues {
  name: string;
  slug: string;
  blueprint: string;
  weight: string;
}

function formValues(form: FormData): BlockTypeFormValues {
  return {
    name: str(form.get('name')),
    slug: str(form.get('slug')),
    blueprint: str(form.get('blueprint')),
    weight: str(form.get('weight')),
  };
}

/** Validates a form submission; returns an error message or null. `ignoreId`
 *  skips the row being edited during the slug-collision check. */
async function validate(c: AppContext, values: BlockTypeFormValues, slug: string, ignoreId?: number): Promise<string | null> {
  if (!values.name) return 'Name is required.';
  if (!slug) return 'Slug is required.';
  if (slug in cmsConfig.blocks) return `Slug "${slug}" is already defined in the config file.`;

  const existing = await c.env.DB.prepare('SELECT id FROM block_types WHERE slug = ?')
    .bind(slug)
    .first<{ id: number }>();
  if (existing && existing.id !== ignoreId) return `Slug "${slug}" is already in use.`;

  try {
    const blueprint = JSON.parse(values.blueprint || '[]');
    if (!Array.isArray(blueprint)) return 'Blueprint must be a JSON array.';
  } catch {
    return 'Blueprint is not valid JSON.';
  }
  return null;
}

// ── List ────────────────────────────────────────────────────────────────────

blockTypesRoutes.get('/block_types', async (c) => {
  const [dbBlockTypes, plugins] = await Promise.all([
    listDbBlockTypes(c.env.DB),
    getPlugins(c.env),
  ]);
  const resolved = await resolveCmsConfig(c.env);
  const dbSlugs = new Set(dbBlockTypes.map((blockType) => blockType.slug));
  // Plugins are merged in registry order, so the last declaration is the
  // effective source when two plugins define the same block type.
  const pluginNameBySlug = new Map<string, string>();
  for (const plugin of plugins) {
    for (const slug of Object.keys(plugin.manifest.contentTypes?.blocks ?? {})) {
      pluginNameBySlug.set(slug, plugin.manifest.name);
    }
  }
  // Read-only types = everything in the resolved config that isn't a DB row:
  // static config-file blocks + those contributed by active plugins.
  const configBlockTypes = Object.keys(resolved.blocks)
    .filter((slug) => !dbSlugs.has(slug))
    .map((slug) => {
      const pluginName = pluginNameBySlug.get(slug) ?? '';
      return { slug, name: slug, source: pluginName ? 'plugin' : 'config', pluginName };
    });

  return renderPage(c, blockTypesPage, {
    dbBlockTypes,
    configBlockTypes,
    canWrite: await userCan(c, 'blocktype:write'),
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

blockTypesRoutes.get('/block_types/new', async (c) => {
  if (!(await userCan(c, 'blocktype:write'))) return c.redirect('/admin/block_types');
  return renderForm(c, { mode: 'new', name: '', slug: '', weight: '5', blueprint: '[]' });
});

blockTypesRoutes.post('/block_types', requirePermission('blocktype:write'), async (c) => {
  const form = await c.req.formData();
  const values = formValues(form);
  const slug = values.slug ? slugify(values.slug) : slugify(values.name);

  const error = await validate(c, values, slug);
  if (error) return renderForm(c, { mode: 'new', error, ...values });

  const result = await c.env.DB.prepare(
    `INSERT INTO block_types (slug, name, blueprint, weight) VALUES (?, ?, ?, ?)`,
  )
    .bind(slug, values.name, values.blueprint || '[]', num(values.weight))
    .run();
  clearConfigCache();
  logAudit(c, 'block_type.create', 'block_type', result.meta.last_row_id, { slug, name: values.name });
  return c.redirect('/admin/block_types');
});

// ── View (read-only, config-file blocks) ──────────────────────────────────────

blockTypesRoutes.get('/block_types/view/:slug', async (c) => {
  const slug = c.req.param('slug');
  // Resolve so plugin-contributed block blueprints are viewable too, not just config-file ones.
  const config = await resolveCmsConfig(c.env);
  const blueprint = config.blocks[slug];
  if (!blueprint) return c.notFound();
  return renderForm(c, {
    mode: 'view',
    name: slug,
    slug,
    weight: '',
    blueprint: JSON.stringify(blueprint, null, 2),
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

blockTypesRoutes.get('/block_types/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const blockType = await c.env.DB.prepare('SELECT * FROM block_types WHERE id = ?')
    .bind(id)
    .first<BlockType>();
  if (!blockType) return c.notFound();
  return renderForm(c, {
    mode: (await userCan(c, 'blocktype:write')) ? 'edit' : 'view',
    id: blockType.id,
    name: blockType.name,
    slug: blockType.slug,
    weight: String(blockType.weight),
    blueprint: blockType.blueprint,
  });
});

blockTypesRoutes.post('/block_types/:id', requirePermission('blocktype:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = await c.env.DB.prepare('SELECT * FROM block_types WHERE id = ?')
    .bind(id)
    .first<BlockType>();
  if (!existing) return c.notFound();

  const form = await c.req.formData();
  const values = formValues(form);
  const slug = values.slug ? slugify(values.slug) : slugify(values.name);

  const error = await validate(c, values, slug, id);
  if (error) return renderForm(c, { mode: 'edit', id, error, ...values });

  await c.env.DB.prepare(
    `UPDATE block_types
        SET slug = ?, name = ?, blueprint = ?, weight = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  )
    .bind(slug, values.name, values.blueprint || '[]', num(values.weight), id)
    .run();
  clearConfigCache();
  logAudit(c, 'block_type.update', 'block_type', id, { slug, name: values.name });
  return c.redirect('/admin/block_types');
});

blockTypesRoutes.post('/block_types/:id/delete', requirePermission('blocktype:write'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM block_types WHERE id = ?').bind(id).run();
  clearConfigCache();
  logAudit(c, 'block_type.delete', 'block_type', id);
  return c.redirect('/admin/block_types');
});

// ── Shared form renderer ──────────────────────────────────────────────────────

type FormModel = BlockTypeFormModel;

async function renderForm(c: AppContext, model: FormModel): Promise<Response> {
  return renderPage(c, blockTypeFormPage, { ...model });
}
