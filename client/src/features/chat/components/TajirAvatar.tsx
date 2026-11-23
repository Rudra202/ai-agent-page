import { Sparkles } from 'lucide-react';
import { cn } from '../../../lib/cn';

export function TajirAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('flex size-7 shrink-0 items-center justify-center rounded-full bg-navy-900 text-white', className)}
    >
      <Sparkles className="size-4" />
    </span>
  );
}

export function TypingIndicator() {
  return (
    <div role="status" aria-label="Tajir is typing" className="flex items-end gap-2">
      <TajirAvatar />
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3.5 shadow-card">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-muted"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
