import { describe, expect, it } from 'vitest';
import type { SidebarNavItem } from '../src/templates/layout';
import { withActiveSidebarItems } from '../src/utils/sidebar';

const item = (label: string, href: string, extra: Partial<SidebarNavItem> = {}): SidebarNavItem => ({
  label,
  href,
  icon: 'menu',
  ...extra,
});

describe('sidebar active route state', () => {
  it('keeps the Pages item active across page-management and search routes', () => {
    const main = [item('Pages', '/admin/pages/list'), item('Tags', '/admin/tags')];

    expect(withActiveSidebarItems('/admin/pages/42/edit', main, []).sidebarNav).toMatchObject([
      { label: 'Pages', isActive: true },
      { label: 'Tags', isActive: false },
    ]);
    expect(withActiveSidebarItems('/admin/advanced-search/default', main, []).sidebarNav[0].isActive).toBe(true);
  });

  it('uses segment boundaries instead of matching similar route names', () => {
    const main = [item('Tags', '/admin/tags')];

    expect(withActiveSidebarItems('/admin/tagsets', main, []).sidebarNav[0].isActive).toBe(false);
  });

  it('activates and expands the Settings group for a nested settings route', () => {
    const main = [
      item('Pages', '/admin'),
      item('Settings', '', { icon: 'settings', isSettingsGroup: true }),
    ];
    const settings = [
      item('Taxonomies', '/admin/taxonomies'),
      item('Page Types', '/admin/page_types'),
    ];
    const result = withActiveSidebarItems('/admin/page_types/7/edit', main, settings);

    expect(result.sidebarNav).toMatchObject([
      { label: 'Pages', isActive: false },
      { label: 'Settings', isActive: true },
    ]);
    expect(result.sidebarSettingsNav).toMatchObject([
      { label: 'Taxonomies', isActive: false },
      { label: 'Page Types', isActive: true },
    ]);
  });

  it('activates the Credit Summary item in Settings', () => {
    const main = [item('Settings', '', { icon: 'settings', isSettingsGroup: true })];
    const settings = [item('Credit Summary', '/admin/settings/credits', { icon: 'coins' })];
    const result = withActiveSidebarItems('/admin/settings/credits', main, settings);

    expect(result.sidebarNav[0].isActive).toBe(true);
    expect(result.sidebarSettingsNav[0].isActive).toBe(true);
  });

  it('selects the longest matching plugin route across sidebar groups', () => {
    const main = [
      item('Events', '/admin/plugins/events'),
      item('Settings', '', { icon: 'settings', isSettingsGroup: true }),
    ];
    const settings = [item('Event Settings', '/admin/plugins/events/settings')];
    const result = withActiveSidebarItems('/admin/plugins/events/settings/notifications?tab=email', main, settings);

    expect(result.sidebarNav).toMatchObject([
      { label: 'Events', isActive: false },
      { label: 'Settings', isActive: true },
    ]);
    expect(result.sidebarSettingsNav[0]).toMatchObject({ label: 'Event Settings', isActive: true });
  });

  it('falls back to the plugin link for deep routes outside its link path', () => {
    const main = [
      item('Events', '/admin/plugins/events/events'),
      item('Check-in', '/admin/plugins/checkin/dashboard'),
    ];
    const result = withActiveSidebarItems('/admin/plugins/events/edm/42/preview', main, []);

    expect(result.sidebarNav).toMatchObject([
      { label: 'Events', isActive: true },
      { label: 'Check-in', isActive: false },
    ]);
  });

  it('uses a page edit return_to destination to keep its plugin highlighted', () => {
    const main = [
      item('Pages', '/admin'),
      item('Events', '/admin/plugins/events/events'),
    ];
    const result = withActiveSidebarItems(
      '/admin/pages/42/edit',
      main,
      [],
      '/admin/plugins/events/guests/7?tab=rsvp',
    );

    expect(result.sidebarNav).toMatchObject([
      { label: 'Pages', isActive: false },
      { label: 'Events', isActive: true },
    ]);
  });

  it('ignores non-admin return_to destinations on page edit', () => {
    const main = [item('Pages', '/admin'), item('Events', '/admin/plugins/events/events')];
    const result = withActiveSidebarItems('/admin/pages/42/edit', main, [], 'https://example.com/admin/plugins/events');

    expect(result.sidebarNav).toMatchObject([
      { label: 'Pages', isActive: true },
      { label: 'Events', isActive: false },
    ]);
  });
});
