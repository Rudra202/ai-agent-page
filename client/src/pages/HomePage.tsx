import { Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_QUICK_REPLIES } from '@tajir/shared';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Composer } from '../features/chat/components/Composer';
import { QuickReplies } from '../features/chat/components/QuickReplies';
import { attentionItems } from '../state/appState';
import { useApp } from '../state/context';

/** Home: the conversational entry point. Anything sent from here continues in /chat. */
export function HomePage() {
  const { state, sendText, continueInChat } = useApp();
  const navigate = useNavigate();

  // What is waiting on the user comes from their real applications, never from sample reminders.
  const items = useMemo(() => attentionItems(state.applications), [state.applications]);
  const [urgent, ...others] = items;

  const ask = (text: string) => {
    void sendText(text);
    navigate('/chat');
  };
  const resolve = (applicationId: string) => {
    void continueInChat(applicationId);
    navigate('/chat');
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="space-y-6">
        {urgent && (
          <section aria-label="Most urgent" className="rounded-card bg-navy-900 p-4 text-white shadow-raised">
            <p className="text-[11px] font-semibold tracking-wider text-brand-200">MOST URGENT</p>
            <div className="mt-2 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-base font-semibold">{urgent.title}</p>
                <p className="mt-0.5 break-words text-xs text-brand-100">{urgent.detail}</p>
              </div>
              <button
                type="button"
                onClick={() => resolve(urgent.applicationId)}
                className="shrink-0 rounded-control bg-white px-4 py-2.5 text-sm font-semibold text-navy-900 hover:bg-brand-50"
              >
                Continue in chat
              </button>
            </div>
          </section>
        )}

        <section className="flex flex-col items-center px-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-navy-900 text-white">
            <Sparkles className="size-6" aria-hidden />
          </span>
          <p className="mt-3 flex items-center gap-1 text-xl font-bold text-navy-900">Tajir</p>
          <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight text-navy-900">What can Tajir help you with today?</h1>
          <p className="mt-2 max-w-sm text-sm text-muted">
            Ask anything about starting, running or managing {state.user.company || 'your business'}.
          </p>
        </section>

        {others.length > 0 && (
          <section aria-labelledby="reminders-heading">
            <h2 id="reminders-heading" className="mb-2 text-[11px] font-semibold tracking-wider text-muted">
              ALSO NEEDED
            </h2>
            <ul className="space-y-3">
              {others.map((item) => (
                <li key={item.id}>
                  <Card className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-navy-900">{item.title}</p>
                      <p className="mt-0.5 break-words text-xs text-muted">{item.detail}</p>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => resolve(item.applicationId)}>
                      Continue
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="composer-dock mt-auto pt-6">
        <QuickReplies options={DEFAULT_QUICK_REPLIES} onPick={ask} />
        <Composer onSend={ask} />
      </div>
    </div>
  );
}
