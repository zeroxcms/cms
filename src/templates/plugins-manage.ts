import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface PluginListItem {
  id: number;
  label: string;
  url: string;
  enabled: boolean;
  /** Resolved from the live manifest, when the plugin is reachable. */
  status: 'active' | 'unreachable' | 'disabled';
  manifestId?: string;
  manifestName?: string;
  version?: string;
  /** True when the manifest declares candidate JS/CSS assets to approve. */
  hasAssets?: boolean;
  /** True when the manifest defines page types/taxonomies or declares delegated access. */
  hasPageTypes?: boolean;
  /** True when the manifest declares configurable quota limits. */
  hasLimits?: boolean;
  /** True when the manifest declares configurable credit costs. */
  hasCredits?: boolean;
}

const STATUS_BADGE: Record<PluginListItem['status'], string> = {
  active: 'bg-green-100 text-green-800',
  unreachable: 'bg-red-100 text-red-800',
  disabled: 'bg-gray-100 text-gray-600',
};

export async function pluginsManagePage(views: Fetcher, opts: BaseTemplateProps & {
  plugins: PluginListItem[];
}): Promise<string> {
  const { plugins } = opts;
  const body = await renderView(views, '/templates/plugins-manage.json', {
    hasPlugins: plugins.length > 0,
    plugins: plugins.map((plugin) => ({
      title: plugin.manifestName || plugin.label || plugin.manifestId || plugin.url,
      subtitle: plugin.manifestId ? `${plugin.manifestId}${plugin.version ? ` · v${plugin.version}` : ''}` : plugin.url,
      url: plugin.url,
      enabled: plugin.enabled,
      status: plugin.status,
      statusKey: `plugins.status.${plugin.status}`,
      statusClass: STATUS_BADGE[plugin.status],
      toggleAction: `/admin/plugins-manage/${plugin.id}/toggle`,
      editHref: `/admin/plugins-manage/${plugin.id}/edit`,
      deleteAction: `/admin/plugins-manage/${plugin.id}/delete`,
      hasAssets: !!plugin.hasAssets,
      assetsHref: `/admin/plugins-manage/${plugin.id}/assets`,
      hasPageTypes: !!plugin.hasPageTypes,
      pageTypesHref: `/admin/plugins-manage/${plugin.id}/page-types`,
      hasLimits: !!plugin.hasLimits,
      limitsHref: `/admin/plugins-manage/${plugin.id}/limits`,
      hasCredits: !!plugin.hasCredits,
      creditsHref: `/admin/plugins-manage/${plugin.id}/credits`,
    })),
  });

  return adminLayout(views, opts, { title: 'Plugins', body });
}

export async function pluginFormPage(views: Fetcher, opts: BaseTemplateProps & {
  isNew: boolean;
  id?: number;
  label: string;
  url: string;
  enabled: boolean;
  sortOrder: number;
  config: string;
  secret?: string;
  tenantKvKey?: string;
  flash?: string;
  error?: string;
}): Promise<string> {
  const { isNew, id, label, url, enabled, sortOrder, config, secret, tenantKvKey, flash, error } = opts;
  const heading = isNew ? 'Register Plugin' : 'Edit Plugin';
  const flashMessageKey = flash === 'secret-generated'
    ? 'plugins.form.registered_flash'
    : flash === 'secret-rotated'
      ? 'plugins.form.rotated_flash'
      : '';

  const body = await renderView(views, '/templates/plugin-form.json', {
    headingKey: isNew ? 'plugins.form.register_title' : 'plugins.form.edit_title',
    action: isNew ? '/admin/plugins-manage' : `/admin/plugins-manage/${id}`,
    submitLabelKey: isNew ? 'plugins.form.register' : 'common.save',
    label,
    url,
    enabled,
    sortOrder,
    config,
    hasError: !!error,
    error: error ?? '',
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    showSecret: !isNew,
    secret: secret ?? '',
    tenantKvKey: tenantKvKey ?? '',
    tenantKvValue: JSON.stringify({ secret: secret ?? '' }),
    usesSharedSecret: !secret,
    rotateSecretAction: isNew ? '' : `/admin/plugins-manage/${id}/rotate-secret`,
  });

  return adminLayout(views, opts, { title: heading, body });
}

export interface PluginAssetRow {
  path: string;
  label: string;
  approved: boolean;
  drifted: boolean;
  fetchError: boolean;
  approvedBy: string;
  integrity: string;
  approveAction: string;
  revokeAction: string;
}

export async function pluginAssetsPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  assets: PluginAssetRow[];
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, assets, flash } = opts;
  const flashMessageKey = flash === 'approved'
    ? 'view_strings.sections_plugin_assets.flash_approved'
    : flash === 'revoked'
      ? 'view_strings.sections_plugin_assets.flash_revoked'
      : flash === 'fetch-failed'
        ? 'view_strings.sections_plugin_assets.flash_fetch_failed'
        : '';

  const body = await renderView(views, '/templates/plugin-assets.json', {
    pluginLabel,
    unreachable,
    hasAssets: assets.length > 0,
    assets: assets.map((asset) => ({
      ...asset,
      statusKey: asset.drifted
        ? 'view_strings.sections_plugin_assets.status_expired'
        : asset.approved
          ? 'view_strings.sections_plugin_assets.status_approved'
          : 'view_strings.sections_plugin_assets.status_not_approved',
      statusClass: asset.drifted ? 'bg-red-400 text-amber-800' : asset.approved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Assets`, body });
}

export interface PluginLimitRow {
  key: string;
  label: string;
  description: string;
  pageType: string;
  scopeLabel: string;
  scopeKey: string;
  scopeDetail: string;
  defaultLabel: string;
  defaultKey: string;
  effectiveLabel: string;
  effectiveKey: string;
  usesDefault: boolean;
  usageLabel: string;
  usageKey: string;
  pageTypeKey: string;
  /** Configured numeric value as a string, or '' when unset/unlimited. */
  value: string;
  unlimited: boolean;
}

export async function pluginLimitsPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  limits: PluginLimitRow[];
  saveAction: string;
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, limits, saveAction, flash } = opts;
  const flashMessageKey = flash === 'saved'
    ? 'view_strings.sections_plugin_limits.flash_saved'
    : '';

  const body = await renderView(views, '/templates/plugin-limits.json', {
    pluginLabel,
    unreachable,
    hasLimits: limits.length > 0,
    limits,
    saveAction,
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Limits`, body });
}

export interface PluginCreditRow {
  key: string;
  label: string;
  description: string;
  chargeLabel: string;
  chargeKey: string;
  chargeDetail: string;
  defaultLabel: string;
  defaultKey: string;
  effectiveLabel: string;
  effectiveKey: string;
  usesDefault: boolean;
  /** Configured price as a string, or '' when unset (default applies). */
  value: string;
}

export async function pluginCreditsPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  credits: PluginCreditRow[];
  saveAction: string;
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, credits, saveAction, flash } = opts;
  const flashMessageKey = flash === 'saved'
    ? 'view_strings.sections_plugin_credits.flash_saved'
    : '';

  const body = await renderView(views, '/templates/plugin-credits.json', {
    pluginLabel,
    unreachable,
    hasCredits: credits.length > 0,
    credits,
    saveAction,
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Credits`, body });
}

export interface PluginPageTypeRow {
  pageType: string;
  pageTypeLabel: string;
  readDeclared: boolean;
  writeDeclared: boolean;
  readApproved: boolean;
  writeApproved: boolean;
  readApprovedBy: string;
  writeApprovedBy: string;
  approveReadAction: string;
  revokeReadAction: string;
  approveWriteAction: string;
  revokeWriteAction: string;
}

export interface PluginDefinedPageTypeRow {
  slug: string;
  fieldCount: number;
  viewHref: string;
}

export interface PluginDefinedTaxonomyRow {
  slug: string;
  name: string;
  viewHref: string;
}

export async function pluginPageTypesPage(views: Fetcher, opts: BaseTemplateProps & {
  pluginId: number;
  pluginLabel: string;
  unreachable: boolean;
  definedPageTypes: PluginDefinedPageTypeRow[];
  definedTaxonomies: PluginDefinedTaxonomyRow[];
  pageTypes: PluginPageTypeRow[];
  flash?: string;
}): Promise<string> {
  const { pluginLabel, unreachable, definedPageTypes, definedTaxonomies, pageTypes, flash } = opts;
  const flashMessageKey = flash === 'approved'
    ? 'view_strings.sections_plugin_page_types.flash_approved'
    : flash === 'revoked'
      ? 'view_strings.sections_plugin_page_types.flash_revoked'
      : '';

  const body = await renderView(views, '/templates/plugin-page-types.json', {
    pluginLabel,
    unreachable,
    hasDefinedPageTypes: definedPageTypes.length > 0,
    definedPageTypes,
    hasDefinedTaxonomies: definedTaxonomies.length > 0,
    definedTaxonomies,
    hasPageTypes: pageTypes.length > 0,
    pageTypes: pageTypes.map((row) => ({
      ...row,
      pageTypeLabelKey: row.pageType === '*' ? 'view_strings.sections_plugin_page_types.all_page_types' : '',
      readStatusKey: row.readApproved
        ? 'view_strings.sections_plugin_page_types.status_approved'
        : 'view_strings.sections_plugin_page_types.status_not_approved',
      readStatusClass: row.readApproved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
      writeStatusKey: row.writeApproved
        ? 'view_strings.sections_plugin_page_types.status_approved'
        : 'view_strings.sections_plugin_page_types.status_not_approved',
      writeStatusClass: row.writeApproved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessageKey,
    flashMessageKey,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Page types`, body });
}
