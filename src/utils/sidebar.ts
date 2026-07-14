import type { SidebarNavItem } from '../templates/layout';

interface SidebarCandidate {
  group: 'main' | 'settings';
  index: number;
  item: SidebarNavItem;
  score: number;
}

function normalizeSidebarPath(value: string): string {
  const path = value.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return path || '/';
}

function isPathOrDescendant(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

function sidebarItemOwnsPath(pathname: string, href: string): boolean {
  const path = normalizeSidebarPath(pathname);
  const target = normalizeSidebarPath(href);
  if (target === '/') return false;

  // The Pages item links to the dashboard, but also owns all page-management
  // and advanced-search screens. It must not claim every /admin route.
  if (target === '/admin') {
    return path === '/admin'
      || isPathOrDescendant(path, '/admin/pages')
      || isPathOrDescendant(path, '/admin/advanced-search');
  }

  return isPathOrDescendant(path, target);
}

/**
 * Marks the single sidebar destination that best owns the current route.
 * Longest-match selection keeps a broad plugin route from also highlighting
 * when a more specific plugin link is present.
 */
export function withActiveSidebarItems(
  pathname: string,
  sidebarNav: SidebarNavItem[],
  sidebarSettingsNav: SidebarNavItem[],
): { sidebarNav: SidebarNavItem[]; sidebarSettingsNav: SidebarNavItem[] } {
  const candidates: SidebarCandidate[] = [
    ...sidebarNav.flatMap((item, index) => item.isSettingsGroup || !item.href ? [] : [{
      group: 'main' as const,
      index,
      item,
      score: normalizeSidebarPath(item.href).length,
    }]),
    ...sidebarSettingsNav.flatMap((item, index) => !item.href ? [] : [{
      group: 'settings' as const,
      index,
      item,
      score: normalizeSidebarPath(item.href).length,
    }]),
  ];
  const active = candidates.reduce<SidebarCandidate | undefined>((best, candidate) => {
    if (!sidebarItemOwnsPath(pathname, candidate.item.href)) return best;
    if (!best || candidate.score > best.score) return candidate;
    return best;
  }, undefined);
  const settingsActive = active?.group === 'settings';

  return {
    sidebarNav: sidebarNav.map((item, index) => ({
      ...item,
      isActive: item.isSettingsGroup
        ? settingsActive
        : active?.group === 'main' && active.index === index,
    })),
    sidebarSettingsNav: sidebarSettingsNav.map((item, index) => ({
      ...item,
      isActive: active?.group === 'settings' && active.index === index,
    })),
  };
}
