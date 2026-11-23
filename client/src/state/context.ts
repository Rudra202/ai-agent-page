import { createContext, useContext } from 'react';
import type { CompanyDraft, WorkflowStep } from '@tajir/shared';
import type { ApiClient } from '../api/types';
import type { UploadCheck } from '../lib/files';
import type { AppState } from './appState';

export interface TurnOutcome {
  /** Reference of the application the turn created, if it created one. */
  createdApplicationId?: string;
  /** Set when the turn could not be completed. The message is safe to show. */
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * What the screens can do. Every action goes to the server and resolves when the
 * server has answered, so a screen can show a busy state and then the outcome.
 */
export interface AppApi {
  state: AppState;
  /** Sends a free-text message to Tajir. */
  sendText: (text: string) => Promise<TurnOutcome>;
  /** Picks an option card. `display` is what the user "says" in the conversation. */
  selectOption: (step: WorkflowStep, cardId: string, display: string) => Promise<TurnOutcome>;
  confirm: (step: WorkflowStep, display?: string) => Promise<TurnOutcome>;
  continueInChat: (applicationId: string) => Promise<TurnOutcome>;
  /** Uploads a file for an application requirement. The server checks and stores it. */
  uploadDocument: (applicationId: string, requirementId: string, file: File, viaChat?: boolean) => Promise<UploadCheck>;
  /** Uploads a file that is not tied to an application. */
  addVaultDocument: (typeId: string, file: File) => Promise<UploadCheck>;
  /** Attaches a file in the chat: uploads it, and Tajir acknowledges it with a card that follows its progress. */
  attachInChat: (file: File) => Promise<UploadCheck>;
  /** Attaches a document that is already in the Documents section to the chat. Nothing is uploaded again. */
  attachExisting: (documentId: string) => Promise<ActionResult>;
  /** Removes a document, its file and what was read from it. */
  removeDocument: (id: string) => Promise<ActionResult>;
  /** Asks for a document to be read again. */
  reprocessDocument: (id: string) => Promise<ActionResult>;
  /** Edits the company draft from the review screen. */
  updateCompany: (patch: Partial<CompanyDraft>) => Promise<ActionResult>;
  /**
   * Prototype only: records the next step an authority or provider would record
   * (under review, completed). The event is labelled as simulated.
   */
  simulateNextStep: (applicationId: string) => Promise<ActionResult & { label?: string }>;
  /** Tries the last failed chat turn again. */
  retryChat: () => Promise<TurnOutcome>;
  dismissChatError: () => void;
  newChat: () => Promise<void>;
  /** Loads the latest applications and documents from the server. */
  refresh: () => Promise<void>;
  /** Loads everything again, after a failed first load. */
  reload: () => Promise<void>;
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppContext);
  if (!api) throw new Error('useApp must be used inside <AppProvider>');
  return api;
}

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiContext.Provider>');
  return api;
}
