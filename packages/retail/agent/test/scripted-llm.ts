import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm.ts';

type Step = LlmResponse | Error | ((req: LlmRequest) => LlmResponse);

let seq = 0;
export function msg(
  content: Anthropic.Beta.BetaContentBlock[],
  stop: LlmResponse['stop_reason'] = 'end_turn',
  model = 'claude-opus-5',
): LlmResponse {
  return {
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as LlmResponse;
}

export const text = (t: string, model?: string) => msg([{ type: 'text', text: t, citations: null } as Anthropic.Beta.BetaTextBlock], 'end_turn', model);

export const toolUse = (...calls: [name: string, input: unknown][]) =>
  msg(
    calls.map(([name, input]) => ({ type: 'tool_use', id: `tu_${++seq}`, name, input }) as Anthropic.Beta.BetaToolUseBlock),
    'tool_use',
  );

/** LLM, отвечающая заранее заданной последовательностью шагов. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('ScriptedLlm: шаги закончились');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : step;
  }
}
