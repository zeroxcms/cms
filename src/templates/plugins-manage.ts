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
      status: plugin.status,
      statusClass: STATUS_BADGE[plugin.status],
      toggleAction: `/admin/plugins-manage/${plugin.id}/toggle`,
      toggleLabel: plugin.enabled ? 'Disable' : 'Enable',
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
  flash?: string;
  error?: string;
}): Promise<string> {
  const { isNew, id, label, url, enabled, sortOrder, config, secret, flash, error } = opts;
  const heading = isNew ? 'Register Plugin' : 'Edit Plugin';
  const flashMessage = flash === 'secret-generated'
    ? 'Plugin registered. Copy the secret below onto the plugin Worker.'
    : flash === 'secret-rotated'
      ? 'Secret rotated. Update the plugin Worker to the new value — the old one no longer works.'
      : '';

  const body = await renderView(views, '/templates/plugin-form.json', {
    heading,
    action: isNew ? '/admin/plugins-manage' : `/admin/plugins-manage/${id}`,
    submitLabel: isNew ? 'Register' : 'Save',
    label,
    url,
    enabled,
    sortOrder,
    config,
    hasError: !!error,
    error: error ?? '',
    hasFlash: !!flashMessage,
    flashMessage,
    showSecret: !isNew,
    secret: secret ?? '',
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
  const flashMessage = flash === 'approved'
    ? 'Asset approved. It will now execute inside CMS chrome for this plugin.'
    : flash === 'revoked'
      ? 'Approval revoked. The asset will no longer execute inside CMS chrome.'
      : flash === 'fetch-failed'
        ? 'Could not fetch the asset from the plugin — approval not changed.'
        : '';

  const body = await renderView(views, '/templates/plugin-assets.json', {
    pluginLabel,
    unreachable,
    hasAssets: assets.length > 0,
    assets: assets.map((asset) => ({
      ...asset,
      statusLabel: asset.drifted ? 'Expired' : asset.approved ? 'Approved' : 'Not approved',
      statusClass: asset.drifted ? 'bg-red-400 text-amber-800' : asset.approved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessage,
    flashMessage,
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
  defaultLabel: string;
  effectiveLabel: string;
  usageLabel: string;
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
  const flashMessage = flash === 'saved'
    ? 'Limits saved. Page quotas apply to every create path; operational limits apply in the plugin.'
    : '';

  const body = await renderView(views, '/templates/plugin-limits.json', {
    pluginLabel,
    unreachable,
    hasLimits: limits.length > 0,
    limits,
    saveAction,
    hasFlash: !!flashMessage,
    flashMessage,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Limits`, body });
}

export interface PluginCreditRow {
  key: string;
  label: string;
  description: string;
  chargeLabel: string;
  defaultLabel: string;
  effectiveLabel: string;
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
  const flashMessage = flash === 'saved'
    ? 'Credit costs saved. New charges use these prices immediately.'
    : '';

  const body = await renderView(views, '/templates/plugin-credits.json', {
    pluginLabel,
    unreachable,
    hasCredits: credits.length > 0,
    credits,
    saveAction,
    hasFlash: !!flashMessage,
    flashMessage,
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
  const flashMessage = flash === 'approved'
    ? 'Page type access approved. The plugin can now use this delegated scope.'
    : flash === 'revoked'
      ? 'Page type access revoked. The plugin can no longer use this delegated scope.'
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
      readStatusLabel: row.readApproved ? 'Approved' : 'Not approved',
      readStatusClass: row.readApproved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
      writeStatusLabel: row.writeApproved ? 'Approved' : 'Not approved',
      writeStatusClass: row.writeApproved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessage,
    flashMessage,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Page types`, body });
}
