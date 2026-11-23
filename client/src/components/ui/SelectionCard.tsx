import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SelectionCardProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Large tappable option used for registration type, jurisdiction and package choices. */
export function SelectionCard({ title, description, icon, selected = false, disabled, onSelect }: SelectionCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-4 rounded-card border bg-surface p-4 text-left shadow-card transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-line hover:border-brand-200',
      )}
    >
      {icon && (
        <span className="flex size-11 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-navy-900">{title}</span>
        {description && <span className="mt-0.5 block text-sm text-muted">{description}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-transparent',
        )}
      >
        <Check className="size-4" />
      </span>
    </button>
  );
}
