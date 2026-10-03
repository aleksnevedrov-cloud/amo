import { hasMention, stripMention } from '@ai-door/shared';
import { PHASE2_TOOLS, type AgentTool, type CrmPort, type ToolContext } from '@ai-door/tools';
import type { Deps } from './deps.ts';
import { sendWazzupMessage } from './wazzup-send.ts';

/**
 * Ответ агента в групповом чате Wazzup (RFD-AI-AGENT-GRUPPOVYE-CHATY, вариант А).
 * У группы нет сделки, поэтому Salesbot её не запускает: ход собирается здесь,
 * ответ уходит прямо в Wazzup. В amoCRM ничего не пишется: ни сделок, ни задач, ни примечаний.
 */

/** Только справочные инструменты — ничего, что меняет CRM. */
const GROUP_TOOLS = new Set([
  'catalog_search',
  'catalog_get_product',
  'knowledge_search',
  'price_calculate',
  'door_components',
]);

/** Максимум ответов агента в одном чате за час — защита от зацикливания. */
const MAX_REPLIES_PER_HOUR = 20;

/** В группе агент ничего не пишет в amoCRM. */
const SILENT_CRM: CrmPort = {
  getContext: async () => null,
  addNote: async () => undefined,
  createTask: async () => undefined,
};

export interface GroupMessage {
  accountId: number;
  chatId: string;
  chatType: string;
  channelId: string | null;
  author: string | null;
  text: string;
}

export type GroupReplyOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'sent'; text: string }
  | { status: 'error'; error: string };

/** Обработка одного входящего сообщения из группы. */
export async function replyInGroup(deps: Deps, msg: GroupMessage): Promise<GroupReplyOutcome> {
  const { accountId, chatId } = msg;
  const text = msg.text.trim();
  const { settings } = await deps.settings.get(accountId);
  const groups = settings.where.groups;

  await deps.groupTurns.add(accountId, chatId, 'client', text, {
    chatType: msg.chatType,
    author: msg.author,
  });

  if (groups.mode === 'block_all') return { status: 'skipped', reason: 'group_blocked' };
  if (groups.mode === 'allowlist' && !groups.allowedChatIds.includes(chatId)) {
    return { status: 'skipped', reason: 'group_not_allowed' };
  }
  if (groups.mentionOnly && !hasMention(text, groups.mention)) {
    return { status: 'skipped', reason: 'group_no_mention' };
  }
  if (!msg.channelId) return { status: 'skipped', reason: 'no_channel' };

  const recent = await deps.groupTurns.repliesSince(accountId, chatId, 60);
  if (recent >= MAX_REPLIES_PER_HOUR) return { status: 'skipped', reason: 'group_rate_limit' };

  const ai = await deps.ai?.(accountId);
  const orchestrator = ai?.orchestrator ?? deps.orchestrator;
  if (!orchestrator) return { status: 'skipped', reason: 'no_ai' };

  const ctx: ToolContext = {
    accountId,
    catalog: deps.catalog,
    knowledge: deps.knowledge,
    components: deps.doorComponents ?? null,
    crm: SILENT_CRM,
    pricing: (await deps.pricing.get(accountId)).rules ?? null,
  };

  const tools: readonly AgentTool[] = PHASE2_TOOLS.filter((t) => GROUP_TOOLS.has(t.name));
  const past = (await deps.groupTurns.history(accountId, chatId, 20)).map((m) => ({
    role: m.role === 'client' ? ('client' as const) : ('ai' as const),
    text: m.text,
  }));
  const incoming = [stripMention(text, groups.mention) || text];

  let result;
  try {
    result = await orchestrator.runTurn({
      settings,
      history: past.slice(0, Math.max(0, past.length - 1)),
      incoming,
      ctx,
      tools,
      now: new Date(),
    });
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }

  if (result.kind !== 'reply' || !result.text.trim()) {
    return { status: 'skipped', reason: result.kind === 'reply' ? 'empty_reply' : result.kind };
  }
  const answer = result.text.trim();
  const sent = await sendWazzupMessage(deps, accountId, {
    channelId: msg.channelId,
    chatId,
    chatType: msg.chatType,
    text: answer,
  });
  if (!sent.ok) return { status: 'error', error: sent.error ?? `http_${sent.status}` };
  await deps.groupTurns.add(accountId, chatId, 'assistant', answer, { chatType: msg.chatType });
  return { status: 'sent', text: answer };
}
