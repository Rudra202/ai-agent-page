import type { ReactNode } from 'react';

export function EmptyState({ icon, title, description, action }: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-line bg-surface px-6 py-10 text-center">
      {icon && <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">{icon}</div>}
      <p className="text-base font-semibold text-navy-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
