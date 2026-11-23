import { createHttp } from './http';
import type { HttpOptions } from './http';
import type { ApiClient, ApplicationView, ConversationState, ConversationView, DocumentDetailView, DocumentStatusView, DocumentView, HealthView, TurnResponse, UserView } from './types';
import { ApiError } from './http';

/** The real API client: every call goes to the Tajir server. */
export function createHttpApi(options: HttpOptions = {}): ApiClient {
  const http = createHttp(options);
  const enc = encodeURIComponent;

  return {
    health: () => http.request<HealthView>('GET', '/api/health'),

    auth: {
      async me() {
        try {
          const { user } = await http.request<{ user: UserView }>('GET', '/api/auth/me', undefined, { expectUnauthorized: true });
          return user;
        } catch (error) {
          // Not signed in is an answer, not a failure.
          if (error instanceof ApiError && error.status === 401) return null;
          throw error;
        }
      },
      async login(input) {
        return (await http.request<{ user: UserView }>('POST', '/api/auth/login', input, { expectUnauthorized: true })).user;
      },
      async register(input) {
        return (await http.request<{ user: UserView }>('POST', '/api/auth/register', input, { expectUnauthorized: true })).user;
      },
      async logout() {
        await http.request<void>('POST', '/api/auth/logout', {}, { expectUnauthorized: true });
      },
    },

    applications: {
      async list() {
        return (await http.request<{ applications: ApplicationView[] }>('GET', '/api/applications')).applications;
      },
      async get(id) {
        return (await http.request<{ application: ApplicationView }>('GET', `/api/applications/${enc(id)}`)).application;
      },
      async simulateNext(id) {
        return (await http.request<{ application: ApplicationView }>('PATCH', `/api/applications/${enc(id)}`, { action: 'simulate_next' })).application;
      },
    },

    documents: {
      async list() {
        return (await http.request<{ documents: DocumentView[] }>('GET', '/api/documents')).documents;
      },
      async get(id) {
        return (await http.request<{ document: DocumentDetailView }>('GET', `/api/documents/${enc(id)}`)).document;
      },
      async status(id) {
        return (await http.request<{ status: DocumentStatusView }>('GET', `/api/documents/${enc(id)}/status`)).status;
      },
      async remove(id) {
        await http.request<void>('DELETE', `/api/documents/${enc(id)}`);
      },
      async reprocess(id) {
        return (await http.request<{ status: DocumentStatusView }>('POST', `/api/documents/${enc(id)}/reprocess`, {})).status;
      },
      file: (id, mode) => http.blob(`/api/documents/${enc(id)}/${mode}`),
      upload(file, fields) {
        const form = new FormData();
        // Fields go first so the server reads them before the file part.
        form.append('typeId', fields.typeId);
        if (fields.applicationId) form.append('applicationId', fields.applicationId);
        if (fields.requirementId) form.append('requirementId', fields.requirementId);
        if (fields.reuseExisting) form.append('reuseExisting', 'true');
        form.append('file', file, file.name);
        return http.request<{ document: DocumentView; application?: ApplicationView; reused?: boolean }>('POST', '/api/documents/upload', form);
      },
    },

    conversations: {
      async list() {
        return (await http.request<{ conversations: ConversationView[] }>('GET', '/api/conversations')).conversations;
      },
      create: () => http.request<ConversationState>('POST', '/api/conversations', {}),
      get: (id) => http.request<ConversationState>('GET', `/api/conversations/${enc(id)}`),
      send: (id, turn) => http.request<TurnResponse>('POST', `/api/conversations/${enc(id)}/messages`, turn),
      updateDraft: (id, company) => http.request('PATCH', `/api/conversations/${enc(id)}/draft`, { company }),
    },
  };
}
