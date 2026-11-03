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
}

export interface Connector {
  start(sink: ConnectorSink): Promise<void>;
  stop(): Promise<void>;
  send(req: OutboundRequest): Promise<{ externalMessageId: string }>;
  typing(externalChatId: string): Promise<void>;
  download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }>;
}

/** Ошибка отправки, которую повторять бессмысленно (клиент заблокировал бота, чат удалён). */
export class PermanentSendError extends Error {}

/** Переподключение: экспоненциальная пауза, не чаще 1 раза в 30 с, не реже 1 раза в 10 мин (раздел 6 ТЗ). */
export function reconnectDelayMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(30_000 * 2 ** (n - 1), 600_000);
}
