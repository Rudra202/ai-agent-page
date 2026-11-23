import { buildFinanceApplication, createSampleApplications, detailRowsOf, provideRequirement, requirementsOfApp } from '@tajir/shared';
import { describe, expect, it } from 'vitest';
import { createdApplicationOf, toApplication, toChatMessage, toChatMessages, toVaultDocument, toWorkflow } from './mappers';
import type { ApplicationView, DocumentView, MessageView } from './types';

const NOW = new Date('2026-11-21T10:00:00Z');

/** What the server sends for an application: details already include derived answers. */
function viewOf(app: ReturnType<typeof createSampleApplications>[number]): ApplicationView {
  return {
    id: app.id,
    service: app.service,
    title: app.title,
    subtitle: app.subtitle,
    status: 'documents_pending',
    statusLabel: 'Documents Pending',
    activityFilter: 'needs_action',
    progress: { total: 0, completedCount: 0, steps: [], current: null } as never,
    requirements: [],
    details: detailRowsOf(app),
    events: app.events,
    nextAction: { text: '', needsAction: false },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    submittedAt: null,
    simulation: { available: false, nextStep: null },
  };
}

describe('toApplication', () => {
  it('does not show an answer twice when the server has already added it to the details', () => {
    const finance = buildFinanceApplication({ amount: 350000, purpose: 'Inventory' }, 'ABC Trading LLC', { now: NOW, newId: (() => { let n = 0; return () => `e${(n += 1)}`; })(), documents: [], existingIds: [] });
    const request = requirementsOfApp(finance).find((r) => r.kind === 'information')!;
    const answered = provideRequirement(finance, request.id, { now: NOW, newId: () => 'ev-answer' }, { actor: 'user', value: 'AED 2,400,000' });
    const view = viewOf(answered);
    expect(view.details.filter((d) => d.label === 'Annual turnover (AED)')).toHaveLength(1);

    const app = toApplication(view);
    // The rebuilt application derives exactly the rows the server sent, not more.
    expect(detailRowsOf(app)).toEqual(view.details);
    expect(app.details.some((d) => d.label === 'Annual turnover (AED)')).toBe(false);
  });

  it('keeps every base row when there are no answers', () => {
    const [first] = createSampleApplications(NOW, () => 'id');
    const view = viewOf(first!);
    expect(toApplication(view).details).toEqual(first!.details);
  });
});

describe('toVaultDocument', () => {
  it('describes a stored document and keeps nothing but its details', () => {
    const view: DocumentView = {
      id: 'd1',
      typeId: 'passport',
      label: 'Passport copy',
      originalName: 'passport.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
      applicationId: 'REG-2026-000001',
      requirementId: 'req-passport',
      processingStatus: 'completed',
      aiStatus: 'skipped',
      detectedType: 'passport',
      errorMessage: null,
      retryCount: 0,
      processedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    expect(toVaultDocument(view)).toEqual({
      id: 'd1',
      typeId: 'passport',
      name: 'passport.pdf',
      sizeBytes: 1234,
      uploadedAt: NOW.toISOString(),
      applicationId: 'REG-2026-000001',
      stored: true,
      mimeType: 'application/pdf',
      processingStatus: 'completed',
      aiStatus: 'skipped',
      detectedType: 'passport',
      errorMessage: null,
    });
  });
});

describe('chat messages', () => {
  const at = NOW.toISOString();
  const message = (over: Partial<MessageView>): MessageView => ({ id: 'm', role: 'assistant', kind: 'text', text: null, payload: null, createdAt: at, ...over });

  it('rebuilds text and cards from what the server stored', () => {
    expect(toChatMessage(message({ role: 'user', text: 'hello' }))).toEqual({ id: 'm', at, role: 'user', kind: 'text', text: 'hello' });
    expect(toChatMessage(message({ text: 'Hi' }))).toEqual({ id: 'm', at, role: 'assistant', kind: 'text', text: 'Hi' });
    expect(toChatMessage(message({ kind: 'status', payload: { applicationId: 'REG-2026-000001' } }))).toEqual({
      id: 'm',
      at,
      role: 'assistant',
      kind: 'status',
      applicationId: 'REG-2026-000001',
    });
  });

  it('drops anything it does not recognise instead of breaking the chat', () => {
    expect(toChatMessage(message({ kind: 'delete_everything', payload: {} }))).toBeNull();
    expect(toChatMessage(message({ kind: 'options', payload: null }))).toBeNull();
    expect(toChatMessages([message({ text: 'ok' }), message({ id: 'x', kind: 'weird' })])).toHaveLength(1);
  });

  it('finds the application a turn created from its status card', () => {
    const messages = toChatMessages([message({ text: 'Done' }), message({ id: 's', kind: 'status', payload: { applicationId: 'FIN-2026-000009' } })]);
    expect(createdApplicationOf(messages)).toBe('FIN-2026-000009');
    expect(createdApplicationOf(toChatMessages([message({ text: 'Nothing created' })]))).toBeUndefined();
  });
});

describe('toWorkflow', () => {
  it('replaces a corrupt or inconsistent workflow with a fresh one', () => {
    expect(toWorkflow({ type: 'company_registration', step: 'review', company: 'nope', finance: {} })).toMatchObject({ type: null, step: 'intent' });
    expect(toWorkflow(null)).toMatchObject({ type: null, step: 'intent' });
    expect(toWorkflow({ type: 'company_registration', step: 'review', company: {}, finance: {} })).toMatchObject({ type: 'company_registration', step: 'review' });
  });
});
