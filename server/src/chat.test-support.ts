import type { AiResponse, WorkflowState } from '@tajir/shared';
import { FALLBACK_AI_RESPONSE } from '@tajir/shared';
import type { InterpretRequest, LlmProvider } from './ai/types.js';
import type { TestAgent } from './test/helpers.js';

/** A conversation driven over the HTTP API, the way the browser does it. */
export class Chat {
  workflow!: WorkflowState;
  quickReplies: string[] = [];
  /** Messages returned by the last turn. */
  last: Array<{ role: string; kind: string; text: string | null; payload: any }> = [];
  mode = '';

  private constructor(
    private readonly agent: TestAgent,
    readonly id: string,
  ) {}

  static async start(agent: TestAgent): Promise<Chat> {
    const res = await agent.post('/api/conversations').send({}).expect(201);
    const chat = new Chat(agent, res.body.conversation.id);
    chat.workflow = res.body.workflow;
    chat.quickReplies = res.body.quickReplies;
    return chat;
  }

  private async post(body: unknown, status = 201) {
    const res = await this.agent.post(`/api/conversations/${this.id}/messages`).send(body as object).expect(status);
    if (status === 201) {
      this.workflow = res.body.workflow;
      this.quickReplies = res.body.quickReplies;
      this.last = res.body.messages.filter((m: { role: string }) => m.role === 'assistant');
      this.mode = res.body.assistant.mode;
    }
    return res;
  }

  say(text: string, status = 201) {
    return this.post({ text }, status);
  }

  select(step: string, cardId: string, display?: string) {
    return this.post({ action: { type: 'select', step, cardId }, display });
  }

  confirm(step = 'review') {
    return this.post({ action: { type: 'confirm', step }, display: 'Confirm & Submit' });
  }

  act(action: Record<string, unknown>, status = 201) {
    return this.post({ action }, status);
  }

  /** All text the assistant wrote in the last turn. */
  get text(): string {
    return this.last
      .filter((m) => m.kind === 'text')
      .map((m) => m.text)
      .join(' ');
  }

  get kinds(): string[] {
    return this.last.map((m) => m.kind);
  }

  /** Everything the assistant said, cards included, as one string for "never says" checks. */
  get everything(): string {
    return JSON.stringify(this.last);
  }

  async stored() {
    return (await this.agent.get(`/api/conversations/${this.id}`).expect(200)).body;
  }
}

export async function applicationsOf(agent: TestAgent): Promise<Array<{ id: string; service: string; status: string; requirements: Array<{ id: string; kind: string; done: boolean }> }>> {
  return (await agent.get('/api/applications').expect(200)).body.applications;
}

// ------------------------------------------------------------ scripted model

export const proposal = (intent: AiResponse['intent'], extracted: NonNullable<AiResponse['extracted']> = {}, message = 'Sure.'): AiResponse => ({
  ...FALLBACK_AI_RESPONSE,
  intent,
  message,
  extracted,
});

export type ScriptedLlm = LlmProvider & { requests: InterpretRequest[]; calls: number };

/** A stand-in model. The handler decides the answer for each request, so tests control exactly what the "model" says. */
export function fakeLlm(handler: (request: InterpretRequest, call: number) => AiResponse | Promise<AiResponse>): ScriptedLlm {
  const provider: ScriptedLlm = {
    kind: 'llm',
    name: 'openai',
    requests: [],
    calls: 0,
    async interpret(request) {
      provider.requests.push(request);
      provider.calls += 1;
      return handler(request, provider.calls);
    },
  };
  return provider;
}

type Handler = Parameters<typeof fakeLlm>[0];

/**
 * Wraps a scripted model so it reads the plain detail answers used by the journey helpers
 * ("Consulting", "Desert Rose", "1", "Skip") the way a real model would, and leaves everything else to `rest`.
 */
export function withDetails(rest: Handler): Handler {
  return (request, call) => {
    switch (request.text) {
      case 'Consulting':
        return proposal('collect_business_details', { activity: 'Consulting' });
      case 'Desert Rose':
        return proposal('collect_business_details', { companyName: 'Desert Rose' });
      case '1':
        return proposal('collect_business_details', { shareholders: 1 });
      case 'Skip':
        return proposal('collect_business_details', { description: '' });
      default:
        return rest(request, call);
    }
  };
}

/** Drives a company chat to the business details step using buttons only, which never call a model. */
export async function toBusinessDetails(chat: Chat, zone = 'shams'): Promise<void> {
  await chat.say('Start a company');
  await chat.select('registration_type', 'free_zone');
  await chat.select('jurisdiction', zone);
}

