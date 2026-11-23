import { Activity, FileText, Home, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Path prefixes that should highlight this tab. */
  match: string[];
}

/** Primary navigation, shared by the desktop sidebar and the mobile bottom bar. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Home', icon: Home, match: ['/dashboard', '/chat', '/company-setup'] },
  { to: '/activity', label: 'Activity', icon: Activity, match: ['/activity', '/applications'] },
  { to: '/documents', label: 'Documents', icon: FileText, match: ['/documents'] },
  { to: '/profile', label: 'Profile', icon: User, match: ['/profile'] },
];

export function isNavActive(item: NavItem, pathname: string): boolean {
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
