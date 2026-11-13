import type { AmojoMessageKind } from '../amojo/client.ts';
import type { ChannelStatus } from '../store.ts';

/** Вложение во входящем: ref — ссылка внутри канала (file_id Telegram и т. п.), скачивается через download(). */
export interface InboundAttachment {
  kind: Exclude<AmojoMessageKind, 'text'>;
  ref: string;
  name: string;
  mime?: string;
  size?: number;
}

/** Событие канала в общем виде для всех мессенджеров. */
export interface InboundEvent {
  externalChatId: string;
  /** Имя клиента или название группы. */
  chatTitle: string;
  isGroup: boolean;
  contact: { username?: string; phone?: string; link?: string };
  /** Автор в групповом чате (в личном — null). */
  author: { id: string; name: string } | null;
  externalMessageId: string;
  text: string;
  attachment: InboundAttachment | null;
  replyToExternalId: string | null;
  /** Unix-время в секундах. */
  timestamp: number;
  /** Сообщение отправлено с телефона менеджера (WhatsApp, Telegram личный), не клиентом. */
  fromMe: boolean;
}

export interface OutboundRequest {
  externalChatId: string;
  text: string;
  file: { data: Buffer; name: string; mime: string; kind: Exclude<AmojoMessageKind, 'text'> } | null;
  replyToExternalId: string | null;
}

export interface ConnectorSink {
  inbound(ev: InboundEvent): Promise<void>;
  status(status: ChannelStatus, detail?: string | null): Promise<void>;
  /** Мессенджер сообщил о доставке или прочтении нашего сообщения. */
  delivery?(externalChatId: string, externalMessageId: string, status: 'delivered' | 'read'): Promise<void>;
  /**
   * Собеседник прочитал все наши сообщения до maxMessageId включительно (Telegram сообщает так, а не по одному).
   * peerKey — начало id чата без access_hash: u:<id>, c:<id>, ch:<id>.
   */
  readUpTo?(peerKey: string, maxMessageId: number): Promise<void>;
  /** Мессенджер сообщил, что наше сообщение не доставлено (нет аккаунта, отказ сервера). */
  sendFailed?(externalChatId: string, externalMessageId: string, reason: string): Promise<void>;
}

/** Точка отсчёта для истории: самое старое сообщение чата, которое у нас уже есть. */
export interface HistoryCursor {
  externalMessageId: string;
  timestamp: number;
  fromMe: boolean;
}

export interface Connector {
  start(sink: ConnectorSink): Promise<void>;
  stop(): Promise<void>;
  send(req: OutboundRequest): Promise<{ externalMessageId: string }>;
  typing(externalChatId: string): Promise<void>;
  download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }>;
  /**
   * «Написать первым»: чат с клиентом по номеру телефона (+79991234567).
   * null — номер не зарегистрирован в мессенджере или скрыт настройками приватности.
   */
  resolvePhone?(phone: string): Promise<{ externalChatId: string; title?: string } | null>;
  /** Канал удалён: отвязать сессию у мессенджера (WhatsApp — «Связанные устройства»). */
  logout?(): Promise<void>;
  /**
   * История переписки из мессенджера (WhatsApp, Telegram личный, MAX по номеру): до limit сообщений старше before
   * (или последних, если before нет), от старых к новым. Загруженные сообщения в amoCRM не передаются.
   */
  history?(externalChatId: string, limit: number, before: HistoryCursor | null): Promise<InboundEvent[]>;
}

/** Ошибка отправки, которую повторять бессмысленно (клиент заблокировал бота, чат удалён). */
export class PermanentSendError extends Error {}

/** Переподключение: экспоненциальная пауза, не чаще 1 раза в 30 с, не реже 1 раза в 10 мин (раздел 6 ТЗ). */
export function reconnectDelayMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(30_000 * 2 ** (n - 1), 600_000);
}

/** Номер телефона в виде +<цифры>: 8XXXXXXXXXX (Россия) → +7XXXXXXXXXX. null — не похоже на номер. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('9')) d = `7${d}`;
  return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
}
