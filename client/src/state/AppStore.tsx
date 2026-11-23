import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { nextExternalStep, requirementsOfApp } from '@tajir/shared';
import type { WorkflowStep } from '@tajir/shared';
import { ApiError } from '../api/http';
import { createdApplicationOf, toApplication, toChatMessages, toVaultDocument, toWorkflow } from '../api/mappers';
import type { ApiClient, ConversationState, TurnBody, UserView } from '../api/types';
import type { UserProfile } from '../domain/types';
import type { ChatMessage } from '../features/chat/types';
import { INITIAL_WORKFLOW } from '../features/chat/types';
import { isActiveStatus } from '../lib/documentStatus';
import { validateUpload } from '../lib/files';
import { newId } from '../lib/id';
import { appendMessages } from './appState';
import type { AppState } from './appState';
import { AppContext } from './context';
import type { ActionResult, AppApi, TurnOutcome } from './context';

function profileOf(user: UserView): UserProfile {
  const name = user.name.trim();
  return { name, firstName: name.split(/\s+/)[0] || name, email: user.email, company: user.company ?? '' };
}

function initialState(user: UserView): AppState {
  return {
    user: profileOf(user),
    documents: [],
    applications: [],
    messages: [],
    workflow: INITIAL_WORKFLOW,
    quickReplies: [],
    pendingReplies: 0,
    conversationId: null,
    load: { status: 'loading' },
    chatError: null,
    aiMode: null,
    aiBackup: null,
    lastReplyMode: null,
  };
}

const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong. Please try again.');

function conversationPart(conversation: ConversationState): Pick<AppState, 'messages' | 'workflow' | 'quickReplies' | 'conversationId' | 'pendingReplies' | 'chatError'> {
  return {
    messages: toChatMessages(conversation.messages),
    workflow: toWorkflow(conversation.workflow),
    quickReplies: conversation.quickReplies,
    conversationId: conversation.conversation.id,
    pendingReplies: 0,
    chatError: null,
  };
}

interface ProviderProps {
  children: ReactNode;
  api: ApiClient;
  user: UserView;
  /** How often to check the server for changes while the page is visible. 0 turns it off. */
  pollMs?: number;
  /** How often to check for progress while a document is being read. 0 turns it off. */
  activePollMs?: number;
}

/**
 * Holds what the screens show and carries out what they ask for. The server is the
 * source of truth: this provider loads from it, sends every change to it, and keeps
 * nothing in the browser. Chat turns are sent one at a time, in order.
 */
export function AppProvider({ children, api, user, pollMs = 20_000, activePollMs = 3_000 }: ProviderProps) {
  const [state, setState] = useState<AppState>(() => initialState(user));
  const stateRef = useRef(state);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inflightLoad = useRef<Promise<void> | null>(null);
  const lastFailed = useRef<{ body: TurnBody; display: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Applies a change synchronously so that two calls in the same tick see each other's result. */
  const update = useCallback((change: (s: AppState) => AppState) => {
    stateRef.current = change(stateRef.current);
    if (mounted.current) setState(stateRef.current);
  }, []);

  // ------------------------------------------------------------------ loading

  const load = useCallback((): Promise<void> => {
    if (inflightLoad.current) return inflightLoad.current;
    update((s) => ({ ...s, load: { status: 'loading' } }));
    const task = (async () => {
      try {
        const [applications, documents, conversations] = await Promise.all([
          api.applications.list(),
          api.documents.list(),
          api.conversations.list(),
        ]);
        // The most recently used chat is the current one. A new account has none yet, so one is opened.
        const current = conversations.find((c) => c.status === 'active');
        const conversation = current ? await api.conversations.get(current.id) : await api.conversations.create();
        update((s) => ({
          ...s,
          applications: applications.map(toApplication),
          documents: documents.map(toVaultDocument),
          ...conversationPart(conversation),
          load: { status: 'ready' },
        }));
        // Which assistant is answering is shown on the profile. It is not needed to use the app.
        api
          .health()
          .then((health) => update((s) => ({ ...s, aiMode: health.ai, aiBackup: health.aiBackup ?? null })))
          .catch(() => undefined);
      } catch (error) {
        update((s) => ({ ...s, load: { status: 'error', error: messageOf(error) } }));
      } finally {
        inflightLoad.current = null;
      }
    })();
    inflightLoad.current = task;
    return task;
  }, [api, update]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Background refresh of server data. A failure is not worth interrupting the user for. */
  const refresh = useCallback(async () => {
    try {
      const [applications, documents] = await Promise.all([api.applications.list(), api.documents.list()]);
      update((s) => ({ ...s, applications: applications.map(toApplication), documents: documents.map(toVaultDocument) }));
    } catch {
      // Keep showing what we have.
    }
  }, [api, update]);

  useEffect(() => {
    const refreshIfIdle = () => {
      const s = stateRef.current;
      if (document.visibilityState === 'visible' && s.load.status === 'ready' && s.pendingReplies === 0) void refresh();
    };
    document.addEventListener('visibilitychange', refreshIfIdle);
    window.addEventListener('focus', refreshIfIdle);
    const timer = pollMs > 0 ? setInterval(refreshIfIdle, pollMs) : undefined;
    return () => {
      document.removeEventListener('visibilitychange', refreshIfIdle);
      window.removeEventListener('focus', refreshIfIdle);
      if (timer) clearInterval(timer);
    };
  }, [refresh, pollMs]);

  // While a document is being read its progress is checked every few seconds, and only then.
  const hasActiveDocument = state.documents.some((d) => isActiveStatus(d.processingStatus));
  useEffect(() => {
    if (!hasActiveDocument || activePollMs <= 0) return undefined;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const documents = await api.documents.list();
        update((s) => ({ ...s, documents: documents.map(toVaultDocument) }));
      } catch {
        // Try again at the next tick.
      }
    };
    const timer = setInterval(() => void check(), activePollMs);
    return () => clearInterval(timer);
  }, [hasActiveDocument, activePollMs, api, update]);

  // -------------------------------------------------------------------- chat

  const executeTurn = useCallback(
    async (body: TurnBody, display: string): Promise<TurnOutcome> => {
      const conversationId = stateRef.current.conversationId;
      if (!conversationId) return { error: 'The conversation is not ready yet. Please try again in a moment.' };

      // The user's own message appears at once. It is replaced by the saved one when the server answers.
      const pending: ChatMessage = { id: `pending-${newId()}`, at: new Date().toISOString(), role: 'user', kind: 'text', text: display };
      const previousQuickReplies = stateRef.current.quickReplies;
      update((s) => ({
        ...s,
        messages: appendMessages(s.messages, [pending]),
        pendingReplies: s.pendingReplies + 1,
        quickReplies: [],
        chatError: null,
      }));

      try {
        const response = await api.conversations.send(conversationId, body);
        const saved = toChatMessages(response.messages);
        update((s) => ({
          ...s,
          messages: appendMessages(
            s.messages.filter((m) => m.id !== pending.id),
            saved,
          ),
          workflow: toWorkflow(response.workflow),
          quickReplies: response.quickReplies,
          pendingReplies: Math.max(0, s.pendingReplies - 1),
          lastReplyMode: response.assistant.mode,
        }));
        lastFailed.current = null;
        // The turn may have created or changed an application, so the lists are read again.
        await refresh();
        return { createdApplicationId: createdApplicationOf(saved.filter((m) => m.role === 'assistant')) };
      } catch (error) {
        const message = messageOf(error);
        lastFailed.current = { body, display };
        update((s) => ({
          ...s,
          messages: s.messages.filter((m) => m.id !== pending.id),
          pendingReplies: Math.max(0, s.pendingReplies - 1),
          quickReplies: previousQuickReplies,
          chatError: message,
        }));
        return { error: message };
      }
    },
    [api, update, refresh],
  );

  /** Turns run one at a time, so the server never sees two changes to the same conversation at once. */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const runTurn = useCallback((body: TurnBody, display: string) => enqueue(() => executeTurn(body, display)), [enqueue, executeTurn]);

  const sendText = useCallback<AppApi['sendText']>(
    (text) => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve({});
      return runTurn({ text: trimmed }, trimmed);
    },
    [runTurn],
  );

  const selectOption = useCallback<AppApi['selectOption']>(
    (step: WorkflowStep, cardId: string, display: string) => {
      const shown = display.slice(0, 120);
      return runTurn({ action: { type: 'select', step, cardId }, display: shown }, shown);
    },
    [runTurn],
  );

  const confirm = useCallback<AppApi['confirm']>(
    (step, display = 'Yes, I confirm and approve - please submit') => runTurn({ action: { type: 'confirm', step }, display }, display),
    [runTurn],
  );

  const continueInChat = useCallback<AppApi['continueInChat']>(
    (applicationId) => {
      const app = stateRef.current.applications.find((a) => a.id === applicationId);
      const display = `Help me finish ${app ? `${app.title} ` : ''}${applicationId}`.slice(0, 120);
      return runTurn({ action: { type: 'clarify', applicationId }, display }, display);
    },
    [runTurn],
  );

  const retryChat = useCallback<AppApi['retryChat']>(() => {
    const failed = lastFailed.current;
    if (!failed) return Promise.resolve({});
    update((s) => ({ ...s, chatError: null }));
    return runTurn(failed.body, failed.display);
  }, [runTurn, update]);

  const dismissChatError = useCallback(() => {
    lastFailed.current = null;
    update((s) => ({ ...s, chatError: null }));
  }, [update]);

  const newChat = useCallback<AppApi['newChat']>(async () => {
    const { messages, workflow } = stateRef.current;
    // A chat nobody has written in yet is already a new chat.
    if (!messages.some((m) => m.role === 'user') && workflow.type === null) return;
    await enqueue(async () => {
      try {
        const conversation = await api.conversations.create();
        update((s) => ({ ...s, ...conversationPart(conversation) }));
      } catch (error) {
        update((s) => ({ ...s, chatError: messageOf(error) }));
      }
    });
  }, [api, enqueue, update]);

  // ----------------------------------------------------------------- documents

  const upload = useCallback(
    async (file: File, fields: { typeId: string; applicationId?: string; requirementId?: string; reuseExisting?: boolean }) => {
      const response = await api.documents.upload(file, fields);
      update((s) => ({
        ...s,
        documents: [toVaultDocument(response.document), ...s.documents.filter((d) => d.id !== response.document.id)],
        applications: response.application ? s.applications.map((a) => (a.id === response.application!.id ? toApplication(response.application!) : a)) : s.applications,
      }));
      return response.document.id;
    },
    [api, update],
  );

  const uploadDocument = useCallback<AppApi['uploadDocument']>(
    async (applicationId, requirementId, file, viaChat = false) => {
      // Quick checks first for instant feedback. The server repeats them and also checks the file's content.
      const check = validateUpload(file);
      if (!check.ok) return check;

      const app = stateRef.current.applications.find((a) => a.id === applicationId);
      const requirement = app ? requirementsOfApp(app).find((r) => r.id === requirementId) : undefined;
      if (!app || !requirement || requirement.kind !== 'document' || !requirement.docTypeId) {
        return { ok: false, error: 'That document is not needed for this application.' };
      }
      if (requirement.done) return { ok: false, error: 'That document has already been provided.' };

      try {
        await upload(file, { typeId: requirement.docTypeId, applicationId, requirementId });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      if (viaChat) {
        const display = `Uploaded ${file.name}`.slice(0, 120);
        await runTurn({ action: { type: 'uploaded', applicationId, requirementId }, display }, display);
      }
      return { ok: true };
    },
    [upload, runTurn],
  );

  const addVaultDocument = useCallback<AppApi['addVaultDocument']>(
    async (typeId, file) => {
      const check = validateUpload(file);
      if (!check.ok) return check;
      try {
        await upload(file, { typeId });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      return { ok: true };
    },
    [upload],
  );

  const attachInChat = useCallback<AppApi['attachInChat']>(
    async (file) => {
      const check = validateUpload(file);
      if (!check.ok) return check;
      let documentId: string;
      try {
        // A file attached in the chat has no type yet: "other". What it turns out to be is read from its content.
        // If the same file is already one of the user's documents, that one is used and no second copy is kept.
        documentId = await upload(file, { typeId: 'other', reuseExisting: true });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const display = `Attached ${file.name}`.slice(0, 120);
      // The file is safe on the server even if the chat cannot acknowledge it, so the upload counts either way.
      // (A failed turn is shown by the chat itself, with a way to try again.)
      await runTurn({ action: { type: 'document_uploaded', documentId }, display }, display);
      return { ok: true };
    },
    [upload, runTurn],
  );

  const attachExisting = useCallback<AppApi['attachExisting']>(
    async (documentId) => {
      const doc = stateRef.current.documents.find((d) => d.id === documentId);
      if (!doc) return { ok: false, error: 'That document is no longer in your Documents.' };
      const display = `Attached ${doc.name}`.slice(0, 120);
      const outcome = await runTurn({ action: { type: 'document_uploaded', documentId }, display }, display);
      return outcome.error ? { ok: false, error: outcome.error } : { ok: true };
    },
    [runTurn],
  );

  const removeDocument = useCallback<AppApi['removeDocument']>(
    async (id) => {
      try {
        await api.documents.remove(id);
      } catch (error) {
        // Already gone is what the user wanted.
        if (!(error instanceof ApiError && error.status === 404)) return { ok: false, error: messageOf(error) };
      }
      update((s) => ({ ...s, documents: s.documents.filter((d) => d.id !== id) }));
      // Removing a document can change what applications show as on record.
      void refresh();
      return { ok: true };
    },
    [api, update, refresh],
  );

  const reprocessDocument = useCallback<AppApi['reprocessDocument']>(
    async (id) => {
      try {
        const status = await api.documents.reprocess(id);
        update((s) => ({
          ...s,
          documents: s.documents.map((d) =>
            d.id === id ? { ...d, processingStatus: status.processingStatus, aiStatus: status.aiStatus, errorMessage: status.errorMessage, detectedType: status.detectedType } : d,
          ),
        }));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    [api, update],
  );

  // ------------------------------------------------------------- other changes

  const updateCompany = useCallback<AppApi['updateCompany']>(
    (patch) =>
      enqueue(async (): Promise<ActionResult> => {
        const conversationId = stateRef.current.conversationId;
        if (!conversationId) return { ok: false, error: 'The conversation is not ready yet.' };
        try {
          const result = await api.conversations.updateDraft(conversationId, patch);
          update((s) => ({ ...s, workflow: toWorkflow(result.workflow), quickReplies: result.quickReplies }));
          return { ok: true };
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
      }),
    [api, enqueue, update],
  );

  const simulateNextStep = useCallback<AppApi['simulateNextStep']>(
    async (applicationId) => {
      const app = stateRef.current.applications.find((a) => a.id === applicationId);
      if (!app) return { ok: false, error: 'Application not found.' };
      const step = nextExternalStep(app.service, app.events);
      if (!step) return { ok: false, error: 'Nothing can be simulated for this application right now.' };
      try {
        const updated = await api.applications.simulateNext(applicationId);
        update((s) => ({ ...s, applications: s.applications.map((a) => (a.id === applicationId ? toApplication(updated) : a)) }));
        return { ok: true, label: step.label };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    [api, update],
  );

  const api_ = useMemo<AppApi>(
    () => ({
      state,
      sendText,
      selectOption,
      confirm,
      continueInChat,
      uploadDocument,
      addVaultDocument,
      attachInChat,
      attachExisting,
      removeDocument,
      reprocessDocument,
      updateCompany,
      simulateNextStep,
      retryChat,
      dismissChatError,
      newChat,
      refresh,
      reload: load,
    }),
    [state, sendText, selectOption, confirm, continueInChat, uploadDocument, addVaultDocument, attachInChat, attachExisting, removeDocument, reprocessDocument, updateCompany, simulateNextStep, retryChat, dismissChatError, newChat, refresh, load],
  );

  return <AppContext.Provider value={api_}>{children}</AppContext.Provider>;
}
