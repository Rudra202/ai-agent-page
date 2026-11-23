import { buildFinanceApplication, createSampleApplications, provideRequirement, requirementsOfApp } from '@tajir/shared';
import { describe, expect, it } from 'vitest';
import { appendMessages, attentionItems, MAX_MESSAGES } from './appState';

const NOW = new Date('2026-11-21T10:00:00Z');

describe('attentionItems', () => {
  it('lists what each application is really waiting for, from its recorded events', () => {
    const items = attentionItems(createSampleApplications(NOW, () => 'id'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      applicationId: 'FIN-2026-050123',
      title: 'Latest 6-month bank statement',
      detail: 'Document needed for Working Capital Finance FIN-2026-050123',
    });
  });

  it('distinguishes documents from information and drops an item once it is provided', () => {
    let n = 0;
    const app = buildFinanceApplication({ amount: 1000, purpose: 'Inventory' }, 'Co', { now: NOW, newId: () => `e${(n += 1)}`, documents: [], existingIds: [] });
    const before = attentionItems([app]);
    expect(before.map((i) => i.detail.split(' for ')[0])).toEqual(['Document needed', 'Information needed']);

    const info = requirementsOfApp(app).find((r) => r.kind === 'information')!;
    const after = provideRequirement(app, info.id, { now: NOW, newId: () => `e${(n += 1)}` }, { actor: 'user', value: 'AED 1' });
    expect(attentionItems([after]).map((i) => i.detail.split(' for ')[0])).toEqual(['Document needed']);
  });

  it('is empty when there are no applications', () => {
    expect(attentionItems([])).toEqual([]);
  });
});

describe('appendMessages', () => {
  it('keeps only the newest messages', () => {
    const make = (i: number) => ({ id: String(i), at: '', role: 'user' as const, kind: 'text' as const, text: String(i) });
    const many = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => make(i));
    const result = appendMessages(many, [make(9999)]);
    expect(result).toHaveLength(MAX_MESSAGES);
    expect(result.at(-1)?.id).toBe('9999');
  });
});
