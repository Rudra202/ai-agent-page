import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

/** Shown while something is being loaded. Announced politely to screen readers. */
export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-muted">
      <Loader2 className="size-6 animate-spin text-brand-600" aria-hidden />
      <p className="text-sm">{label}</p>
    </div>
  );
}

/** Shown when loading failed. It says what happened in plain words and offers a retry. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  action,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center rounded-card border border-danger-600/30 bg-danger-50 px-6 py-10 text-center">
      <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-surface text-danger-600">
        <AlertTriangle className="size-6" aria-hidden />
      </span>
      <p className="text-base font-semibold text-navy-900">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {onRetry && <Button onClick={onRetry}>{retryLabel}</Button>}
        {action}
      </div>
    </div>
  );
}

/** A short confirmation that something worked. */
export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-control bg-success-50 px-3 py-2 text-sm text-success-600">
      {children}
    </p>
  );
}
