import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AvitoApi } from './connectors/avito.ts';
import { GreenApi } from './connectors/max-greenapi.ts';
import { ApiError } from './connectors/http.ts';
import { MaxApi } from './connectors/max.ts';
import { TelegramApiError, TelegramBotApi } from './connectors/telegram-bot.ts';
import { VkApi } from './connectors/vk.ts';
import type { ChannelKind, ChannelStatus } from './store.ts';

/** Данные для подключения канала из виджета: Telegram-бот (этап 1), WhatsApp по QR (этап 2), Telegram личный (3), MAX, VK, Авито (4). */
export const createChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('telegram_bot'),
    token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, 'Неверный формат токена бота'),
    title: z.string().trim().max(100).optional(),
  }),
  z.object({
    kind: z.literal('whatsapp'),
    title: z.string().trim().max(100).optional(),
  }),
  z.object({
    kind: z.literal('telegram_user'),
    title: z.string().trim().max(100).optional(),
  }),
  z.object({
    kind: z.literal('max'),
    token: z.string().trim().min(20, 'Введите токен бота MAX').max(300),
    title: z.string().trim().max(100).optional(),
  }),
  z.object({
    kind: z.literal('vk'),
    token: z.string().trim().min(20, 'Введите ключ доступа сообщества').max(300),
    groupId: z.coerce.number().int().positive('Введите id сообщества (число)'),
    title: z.string().trim().max(100).optional(),
  }),
  z.object({
    kind: z.literal('max_phone'),
    idInstance: z.string().trim().regex(/^\d{6,12}$/, 'idInstance — число из личного кабинета GREEN-API'),
    apiTokenInstance: z.string().trim().regex(/^[A-Za-z0-9]{20,80}$/, 'apiTokenInstance — ключ из личного кабинета GREEN-API'),
    title: z.string().trim().max(100).optional(),
  }),
  z.object({
    kind: z.literal('avito'),
    clientId: z.string().trim().min(4, 'Введите client_id').max(200),
    clientSecret: z.string().trim().min(8, 'Введите client_secret').max(300),
    userId: z.coerce.number().int().positive('Введите id профиля Авито (число)'),
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

/** Проверка ключей у самого мессенджера до сохранения. Ключи в тексте ошибок не появляются. */
export async function validateChannel(input: CreateChannelInput, opts: { fetch?: typeof fetch } = {}): Promise<ValidatedChannel> {
  // WhatsApp: ключей нет, вход по QR. Номер станет external_id после сканирования.
  if (input.kind === 'whatsapp') return { kind: 'whatsapp', title: input.title || 'WhatsApp (ожидает QR)', externalId: `pending-${randomUUID()}`, credentials: {} };
  // Telegram личный: тоже вход по QR, номер аккаунта станет external_id после входа.
  if (input.kind === 'telegram_user') return { kind: 'telegram_user', title: input.title || 'Telegram (ожидает QR)', externalId: `pending-${randomUUID()}`, credentials: {} };
  const net = { ...opts, retry: { retries: 1 } };

  if (input.kind === 'max') {
    try {
      const me = await new MaxApi(input.token, net).getMe();
      return { kind: 'max', title: input.title || (me.username ? `@${me.username}` : me.name), externalId: String(me.user_id), credentials: { token: input.token } };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) throw new ChannelValidationError('MAX не принял токен бота');
      throw new ChannelValidationError('Не удалось проверить токен: нет связи с MAX');
    }
  }

  if (input.kind === 'vk') {
    try {
      const g = await new VkApi(input.token, net).ownGroup();
      if (g.id !== input.groupId) throw new ChannelValidationError(`Ключ выдан другому сообществу (id ${g.id})`);
      return { kind: 'vk', title: input.title || g.name, externalId: String(g.id), credentials: { token: input.token, groupId: String(g.id) } };
    } catch (err) {
      if (err instanceof ChannelValidationError) throw err;
      const code = err instanceof ApiError ? Number(err.apiCode) : 0;
      if (code === 5 || code === 27 || code === 28) throw new ChannelValidationError('VK не принял ключ доступа сообщества');
      if (code === 7 || code === 15 || code === 100) throw new ChannelValidationError('Ключ не даёт доступа к сообществу: нужен ключ сообщества с правами «Сообщения», «Фотографии», «Документы», «Управление сообществом»');
      throw new ChannelValidationError('Не удалось проверить ключ: нет связи с VK');
    }
  }

  if (input.kind === 'max_phone') {
    try {
      const api = new GreenApi({ idInstance: input.idInstance, apiTokenInstance: input.apiTokenInstance }, net);
      const { stateInstance } = await api.getStateInstance();
      const acc = stateInstance === 'authorized' ? await api.getAccountSettings().catch(() => null) : null;
      const phone = acc?.phone ? `+${String(acc.phone).replace(/\D/g, '')}` : null;
      return {
        kind: 'max_phone',
        title: input.title || (phone ? `MAX ${phone}` : `MAX (GREEN-API ${input.idInstance}, ожидает QR)`),
        externalId: phone ?? `ga-${input.idInstance}`,
        // Секрет вебхука уходит в GREEN-API как webhookUrlToken и сверяется с заголовком Authorization.
        credentials: { idInstance: input.idInstance, apiTokenInstance: input.apiTokenInstance, webhookSecret: randomBytes(24).toString('hex') },
      };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 400)) {
        throw new ChannelValidationError('GREEN-API не принял idInstance или apiTokenInstance — проверьте их в console.green-api.com');
      }
      throw new ChannelValidationError('Не удалось проверить инстанс: нет связи с GREEN-API');
    }
  }

  if (input.kind === 'avito') {
    try {
      const api = new AvitoApi({ clientId: input.clientId, clientSecret: input.clientSecret, userId: input.userId }, net);
      const me = await api.self();
      if (Number(me.id) !== input.userId) throw new ChannelValidationError(`Ключи выданы другому профилю Авито (id ${me.id})`);
      return {
        kind: 'avito',
        title: input.title || me.name || `Авито ${me.id}`,
        externalId: String(me.id),
        // Секрет вебхука: часть адреса, по которой api узнаёт запрос Авито.
        credentials: { clientId: input.clientId, clientSecret: input.clientSecret, userId: String(input.userId), webhookSecret: randomBytes(24).toString('hex') },
      };
    } catch (err) {
      if (err instanceof ChannelValidationError) throw err;
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) throw new ChannelValidationError('Авито не принял client_id и client_secret');
      if (err instanceof ApiError && err.status === 403) throw new ChannelValidationError('У приложения Авито нет доступа к мессенджеру — включите Messenger API в кабинете разработчика');
      throw new ChannelValidationError('Не удалось проверить ключи: нет связи с Авито');
    }
  }

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
  max_phone: 'MAX по номеру',
};

/** Каналы, где можно написать первым по номеру телефона. */
export const PHONE_START_KINDS: ReadonlySet<ChannelKind> = new Set(['whatsapp', 'telegram_user', 'max_phone']);
/** Каналы, где написать можно только тем, кто уже писал боту или сообществу (выбор из существующих чатов). */
export const CHAT_START_KINDS: ReadonlySet<ChannelKind> = new Set(['vk', 'max']);
