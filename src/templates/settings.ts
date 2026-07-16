import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface SystemSettingsMenuOption {
  value: string;
  label: string;
  description: string;
  labelKey: string;
  descriptionKey: string;
  checked: boolean;
  locked: boolean;
  weight: number;
}

export interface SystemSettingsPluginOption {
  label: string;
  groupLabel: string;
  groupKey: string;
  href: string;
  key: string;
  formKey: string;
  checked: boolean;
  weight: number;
  icon: string;
}

export interface SystemSettingsIconOption {
  value: string;
  label: string;
  labelKey: string;
  selected: boolean;
}

export async function systemSettingsPage(views: Fetcher, opts: BaseTemplateProps & {
  appName: string;
  appIcon: string;
  adminHomePath: string;
  systemTimezone: string;
  timezoneOptions: Array<{ value: string; label: string; selected: boolean }>;
  iconOptions: SystemSettingsIconOption[];
  settingsGroupWeight: number;
  mainOptions: SystemSettingsMenuOption[];
  settingsOptions: SystemSettingsMenuOption[];
  options: SystemSettingsMenuOption[];
  pluginOptions: SystemSettingsPluginOption[];
  flashKey?: string;
  errorKey?: string;
}): Promise<string> {
  const body = await renderView(views, '/templates/menu-settings.json', {
    appName: opts.appName,
    appIcon: opts.appIcon,
    adminHomePath: opts.adminHomePath,
    systemTimezone: opts.systemTimezone,
    timezoneOptions: opts.timezoneOptions,
    iconOptions: opts.iconOptions,
    settingsGroupWeight: opts.settingsGroupWeight,
    mainOptions: opts.mainOptions,
    hasMainOptions: opts.mainOptions.length > 0,
    settingsOptions: opts.settingsOptions,
    hasSettingsOptions: opts.settingsOptions.length > 0,
    options: opts.options,
    pluginOptions: opts.pluginOptions,
    hasPluginOptions: opts.pluginOptions.length > 0,
    hasFlash: !!opts.flashKey,
    flashKey: opts.flashKey ?? '',
    hasError: !!opts.errorKey,
    errorKey: opts.errorKey ?? '',
  });
  return adminLayout(views, opts, { title: 'System Settings', body });
}
