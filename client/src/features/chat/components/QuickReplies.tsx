/** Horizontally scrolling suggestion chips shown above the composer. */
export function QuickReplies({ options, onPick }: { options: string[]; onPick: (label: string) => void }) {
  if (options.length === 0) return null;
  return (
    <div role="group" aria-label="Suggested replies" className="no-scrollbar -mx-4 mb-2 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
      {options.map((label) => (
        <button
          key={label}
          type="button"
          onClick={() => onPick(label)}
          className="shrink-0 rounded-full border border-line bg-surface px-3.5 py-2 text-xs font-medium text-navy-800 shadow-card hover:bg-brand-50"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
