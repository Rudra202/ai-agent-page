export function formatAed(amount: number): string {
  return `AED ${Math.round(amount).toLocaleString('en-US')}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 2026-08-11 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 08-18 (used on timelines) */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 28 Aug */
export function formatDayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.ceil(ms / 86_400_000);
}

export function describeDaysLeft(iso: string, now: Date): string {
  const days = daysUntil(iso, now);
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return 'due today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
