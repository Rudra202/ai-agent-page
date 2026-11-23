import { cn } from '../../../lib/cn';
import { useApp } from '../../../state/context';
import type { ChatMessage } from '../types';
import { StatusListMessage, StatusMessageCard, UploadMessageCard } from './ApplicationMessages';
import { DocumentMessageCard, DocumentSources } from './DocumentMessages';
import { OptionCards } from './OptionCards';
import { SummaryCard } from './SummaryCard';
import { TajirAvatar, TypingIndicator } from './TajirAvatar';

/**
 * Only the newest card of the current workflow step can be acted on. Older
 * cards stay readable but disabled, so a stale tap cannot move the workflow.
 */
function activeActionableId(messages: ChatMessage[], step: string): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'assistant' && (m.kind === 'options' || m.kind === 'summary')) {
      return m.step === step ? m.id : null;
    }
  }
  return null;
}

export function MessageList() {
  const { state, selectOption, confirm } = useApp();
  const { messages, workflow, pendingReplies } = state;
  const activeId = activeActionableId(messages, workflow.step);

  return (
    <div className="flex flex-1 flex-col justify-end gap-3" role="log" aria-live="polite" aria-label="Conversation with Tajir">
      {messages.map((message, index) => {
        if (message.role === 'user') {
          return (
            <div key={message.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-navy-900 px-4 py-3 text-sm text-white">
                {message.text}
              </p>
            </div>
          );
        }

        const previous = messages[index - 1];
        const showAvatar = !previous || previous.role !== 'assistant';

        return (
          <div key={message.id} className="flex items-end gap-2">
            {showAvatar ? <TajirAvatar /> : <span className="w-7 shrink-0" aria-hidden />}
            <div className={cn('min-w-0', message.kind === 'text' ? 'max-w-[85%]' : 'flex-1')}>
              {message.kind === 'text' && (
                <>
                  <p className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3 text-sm text-ink shadow-card">
                    {message.text}
                  </p>
                  {'sources' in message && message.sources && <DocumentSources sources={message.sources} />}
                </>
              )}
              {message.kind === 'document' && <DocumentMessageCard documentId={message.documentId} name={message.name} typeLabel={message.typeLabel} status={message.status} />}
              {message.kind === 'options' && (
                <OptionCards
                  message={message}
                  active={message.id === activeId}
                  onSelect={(cardId, title) =>
                    selectOption(
                      message.step,
                      cardId,
                      message.step === 'registration_type' ? title : `I'd like to go with ${title}`,
                    )
                  }
                />
              )}
              {message.kind === 'summary' && (
                <SummaryCard message={message} active={message.id === activeId} onConfirm={() => confirm(message.step)} />
              )}
              {message.kind === 'status' && <StatusMessageCard applicationId={message.applicationId} />}
              {message.kind === 'status_list' && <StatusListMessage applicationIds={message.applicationIds} />}
              {message.kind === 'upload' && <UploadMessageCard applicationId={message.applicationId} />}
            </div>
          </div>
        );
      })}
      {pendingReplies > 0 && <TypingIndicator />}
    </div>
  );
}
