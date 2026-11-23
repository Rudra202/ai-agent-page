import type { Application } from '../applications.js';
import { createSampleApplications, SAMPLE_DOCUMENT_TYPES } from '../sample.js';
import { respond, settleLocally } from './engine.js';
import type { EngineContext, EngineInput, EngineResult } from './engine.js';
import { INITIAL_WORKFLOW } from './types.js';
import type { AssistantContent, ChatUser, WorkflowState } from './types.js';

export const NOW = new Date('2026-11-21T10:00:00Z');

export const USER: ChatUser = { name: 'Ahmed Al Mansoori', firstName: 'Ahmed', company: 'ABC Trading LLC' };

/** What the caller sees after a turn, once any effect has been carried out. */
export interface TurnView {
  workflow: WorkflowState;
  replies: AssistantContent[];
  quickReplies: string[];
}

/** Drives the pure engine the way the browser store does, carrying out effects locally between turns. */
export class Session {
  workflow: WorkflowState = INITIAL_WORKFLOW;
  applications: Application[];
  documents: Array<{ typeId: string }> = SAMPLE_DOCUMENT_TYPES.map((typeId) => ({ typeId }));
  last!: TurnView;
  /** Reference of the application created by the last turn, if any. */
  created: string | undefined;
  private counter = 0;
  private randoms = [0.123456, 0.654321, 0.111111, 0.222222];

  constructor() {
    this.applications = createSampleApplications(NOW, () => `seed-${(this.counter += 1)}`);
  }

  ctx(): EngineContext {
    return {
      applications: this.applications,
      documents: this.documents,
      user: USER,
      now: NOW,
      newId: () => `id-${(this.counter += 1)}`,
      random: () => this.randoms[this.counter % this.randoms.length] ?? 0.5,
    };
  }

  /** Runs one engine step and carries out its effects. */
  send(input: EngineInput | string): TurnView {
    const engineInput: EngineInput = typeof input === 'string' ? { type: 'text', text: input } : input;
    return this.settle(respond(this.workflow, engineInput, this.ctx()));
  }

  /** Carries out the effects of a result that came from somewhere other than `respond`. */
  settle(result: EngineResult): TurnView {
    const settled = settleLocally(result, this.ctx());
    this.workflow = settled.workflow;
    this.applications = settled.applications;
    this.created = settled.createdApplicationId;
    this.last = { workflow: settled.workflow, replies: settled.replies, quickReplies: settled.quickReplies };
    return this.last;
  }

  get text(): string {
    return this.last.replies
      .filter((r): r is Extract<AssistantContent, { kind: 'text' }> => r.kind === 'text')
      .map((r) => r.text)
      .join(' ');
  }
}

/** Walks the company journey up to the summary card. */
export function companyJourneyUntilReview(s: Session, type: 'Free Zone' | 'Offshore' = 'Free Zone', zone = 'shams', packageSuffix = 'starter'): void {
  s.send('Start a company');
  s.send({ type: 'select', step: 'registration_type', cardId: type === 'Free Zone' ? 'free_zone' : 'offshore' });
  s.send({ type: 'select', step: 'jurisdiction', cardId: zone });
  s.send('Media & Marketing');
  s.send('Vinith Media');
  s.send('1');
  s.send('Skip');
  s.send({ type: 'select', step: 'package_selection', cardId: `${zone}-${packageSuffix}` });
}
