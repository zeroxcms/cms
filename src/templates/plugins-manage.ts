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
      statusLabel: asset.drifted ? 'Changed since approval' : asset.approved ? 'Approved' : 'Not approved',
      statusClass: asset.drifted ? 'bg-amber-100 text-amber-800' : asset.approved ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600',
    })),
    hasFlash: !!flashMessage,
    flashMessage,
    backHref: '/admin/plugins-manage',
  });

  return adminLayout(views, opts, { title: `${pluginLabel} · Assets`, body });
}
