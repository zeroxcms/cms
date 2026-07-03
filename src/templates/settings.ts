import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface MenuSettingsOption {
  value: string;
  label: string;
  description: string;
  checked: boolean;
}

export async function menuSettingsPage(views: Fetcher, opts: BaseTemplateProps & {
  options: MenuSettingsOption[];
  flash?: string;
}): Promise<string> {
  const body = await renderView(views, '/templates/menu-settings.json', {
    options: opts.options,
    hasFlash: !!opts.flash,
    flash: opts.flash ?? '',
  });
  return adminLayout(views, opts, { title: 'Menu Settings', body });
}
