import { useEffect, useRef } from 'react';
import { Button } from '../components/ui/Button';
import { Composer } from '../features/chat/components/Composer';
import { MessageList } from '../features/chat/components/MessageList';
import { QuickReplies } from '../features/chat/components/QuickReplies';
import { DEFAULT_QUICK_REPLIES } from '@tajir/shared';
import { useApp } from '../state/context';

export function ChatPage() {
  const { state, sendText, retryChat, dismissChatError } = useApp();
  const opened = useRef(false);

  useEffect(() => {
    // Scroll to the very end of the page, not to an element: the composer and the
    // bottom bar are fixed or sticky and would otherwise cover the newest content.
    // Jump instantly when the chat opens and animate for new messages.
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: opened.current ? 'smooth' : 'auto',
    });
    opened.current = true;
  }, [state.messages.length, state.pendingReplies, state.chatError]);

  const chips =
    state.quickReplies.length > 0
      ? state.quickReplies
      : state.workflow.type === null && state.pendingReplies === 0
        ? DEFAULT_QUICK_REPLIES
        : [];

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Chat with Tajir</h1>
      <MessageList />
      {state.aiMode === 'rules' && (
        <p role="note" className="mt-3 rounded-card bg-warning-50 px-4 py-3 text-xs text-warning-600">
          The AI assistant is not connected, so Tajir can only follow the guided company and finance steps and cannot answer general questions. Add a
          Gemini or OpenAI key in the server settings to turn it on.
        </p>
      )}
      {state.aiMode !== 'rules' && state.lastReplyMode === 'fallback' && (
        <p role="note" className="mt-3 rounded-card bg-warning-50 px-4 py-3 text-xs text-warning-600">
          The AI assistant could not be reached for that message, so the built-in guide answered instead. Try again in a moment.
        </p>
      )}
      {state.chatError && (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-danger-600/30 bg-danger-50 px-4 py-3 text-sm text-danger-600">
          <p className="min-w-0 flex-1 break-words">{state.chatError} Your message was not sent.</p>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => void retryChat()}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissChatError}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
      <div className="composer-dock mt-3">
        <QuickReplies options={chips} onPick={(label) => void sendText(label)} />
        <Composer onSend={(text) => void sendText(text)} />
      </div>
    </div>
  );
}
