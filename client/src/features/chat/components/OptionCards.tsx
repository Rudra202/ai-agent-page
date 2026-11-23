import { Check } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import type { AssistantMessage } from '../types';

type OptionsMessage = Extract<AssistantMessage, { kind: 'options' }>;

/** Interactive selection cards (registration type, jurisdiction, package). */
export function OptionCards({
  message,
  active,
  onSelect,
}: {
  message: OptionsMessage;
  active: boolean;
  onSelect: (cardId: string, title: string) => void;
}) {
  return (
    <section aria-label={message.eyebrow} className="space-y-3">
      <p className="text-[11px] font-semibold tracking-wider text-muted">{message.eyebrow}</p>
      <ul className="space-y-3">
        {message.cards.map((card) => (
          <li key={card.id}>
            <Card className="p-4">
              <h3 className="text-base font-semibold text-navy-900">{card.title}</h3>
              {card.description && <p className="mt-0.5 text-sm text-muted">{card.description}</p>}

              {card.tags && card.tags.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {card.tags.map((tag) => (
                    <li
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full border border-brand-100 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700"
                    >
                      <Check className="size-3" aria-hidden />
                      {tag}
                    </li>
                  ))}
                </ul>
              )}

              {card.facts && card.facts.length > 0 && (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
                  {card.facts.map((fact) => (
                    <div key={fact.label}>
                      <dt className="text-xs text-muted">{fact.label}</dt>
                      <dd className="font-semibold text-navy-900">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {card.bullets?.map((group) => (
                <div key={group.heading} className="mt-3 text-sm">
                  <p className="text-xs font-semibold text-muted">{group.heading}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink">
                    {group.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}

              <Button
                fullWidth
                className="mt-4"
                disabled={!active}
                aria-label={`${card.actionLabel} ${card.title}`}
                onClick={() => onSelect(card.id, card.title)}
              >
                {card.actionLabel}
              </Button>
            </Card>
          </li>
        ))}
      </ul>
      {message.note && <p className="text-[11px] text-muted">{message.note}</p>}
    </section>
  );
}
