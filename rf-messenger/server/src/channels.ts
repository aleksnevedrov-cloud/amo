import { z } from 'zod';
import { TelegramApiError, TelegramBotApi } from './connectors/telegram-bot.ts';
import type { ChannelKind, ChannelStatus } from './store.ts';

/** Данные для подключения канала из виджета. Сейчас — Telegram-бот (этап 1). */
export const createChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('telegram_bot'),
    token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, 'Неверный формат токена бота'),
    title: z.string().trim().max(100).optional(),
  }),
]);
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export interface ValidatedChannel {
  kind: ChannelKind;
  title: string;
  externalId: string;
  credentials: Record<string, string>;
}

export class ChannelValidationError extends Error {}

/** Проверка ключей у самого мессенджера до сохранения. */
export async function validateChannel(input: CreateChannelInput, opts: { fetch?: typeof fetch } = {}): Promise<ValidatedChannel> {
  try {
    const me = await new TelegramBotApi(input.token, opts).getMe();
    return { kind: 'telegram_bot', title: input.title || `@${me.username}`, externalId: String(me.id), credentials: { token: input.token } };
  } catch (err) {
    if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) throw new ChannelValidationError('Telegram не принял токен бота');
    throw new ChannelValidationError('Не удалось проверить токен: нет связи с Telegram');
  }
}

/** Подписи статусов для виджета (раздел 5 ТЗ). */
export const STATUS_TEXT: Record<ChannelStatus, string> = {
  starting: 'Подключается…',
  connected: 'Подключён',
  no_phone: 'Нет связи с телефоном',
  session_ended: 'Сессия завершена — нужен новый QR / вход',
  error: 'Ошибка',
};

export const KIND_TEXT: Record<ChannelKind, string> = {
  telegram_bot: 'Telegram-бот',
  whatsapp: 'WhatsApp',
  telegram_user: 'Telegram',
  max: 'MAX',
  vk: 'VK',
  avito: 'Авито',
};
