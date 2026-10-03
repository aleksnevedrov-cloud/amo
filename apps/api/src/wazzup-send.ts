import type { Deps } from './deps.ts';

const WAZZUP_API = 'https://api.wazzup24.com/v3';

export interface WazzupOutgoing {
  channelId: string;
  chatId: string;
  chatType: string;
  text: string;
}

/**
 * Отправка сообщения в чат через Wazzup API напрямую, минуя amoCRM.
 * Нужна для групповых чатов: у них нет сделки, а значит нет и return_url Salesbot.
 */
export async function sendWazzupMessage(
  deps: Pick<Deps, 'fetch' | 'secrets'>,
  accountId: number,
  msg: WazzupOutgoing,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const apiKey = await deps.secrets.get(accountId, 'wazzup');
  if (!apiKey) return { ok: false, status: 0, error: 'no_key' };
  const res = await deps.fetch(`${WAZZUP_API}/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channelId: msg.channelId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      text: msg.text.slice(0, 4000),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) return { ok: true, status: res.status };
  const body = await res.text().catch(() => '');
  return { ok: false, status: res.status, error: body.slice(0, 300) };
}
