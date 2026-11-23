import { useId } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const inputClass =
  'h-11 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 disabled:bg-canvas disabled:text-muted';

/** Labelled form control with an inline error that screen readers announce. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-msg`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-navy-900">
        {label}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': error || hint ? messageId : undefined })}
      {(error || hint) && (
        <p id={messageId} role={error ? 'alert' : undefined} className={cn('mt-1 text-xs', error ? 'text-danger-600' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
