import { ApiError, fileForm, HttpClient, pause, type HttpOptions } from './http.ts';
import { splitText } from './telegram-bot.ts';
import { PermanentSendError, reconnectDelayMs, type Connector, type ConnectorSink, type HistoryCursor, type InboundAttachment, type InboundEvent, type OutboundRequest } from './types.ts';

/**
 * MAX по номеру телефона через GREEN-API (API MAX, v3): инстанс GREEN-API привязан к номеру телефона
 * заказчика по QR, как связанное устройство. Приём — вебхук на наш адрес (webhookUrl + webhookUrlToken
 * выставляются методом setSettings), при его отсутствии — опрос receiveNotification / deleteNotification.
 * Отправка — sendMessage / sendFileByUpload. Идут напрямую, без прокси (российский сервис).
 * Токен инстанса передаётся в пути запроса и не попадает в ошибки и журнал.
 */

export interface GreenApiCredentials {
  idInstance: string;
  apiTokenInstance: string;
  /** Хосты API из личного кабинета; пусто — выводятся из idInstance (первые 4 цифры). */
  apiUrl?: string;
  mediaUrl?: string;
}

/** Хосты GREEN-API по умолчанию — как в личном кабинете для инстансов MAX (apiUrl = mediaUrl = https://api.green-api.com). */
export const GREEN_API_DEFAULT_HOST = 'https://api.green-api.com';

/** Хосты API: из ключей канала (apiUrl / mediaUrl из кабинета), иначе общий хост. По idInstance ничего не вычисляется. */
export function greenApiHosts(_idInstance: string, over: { apiUrl?: string; mediaUrl?: string } = {}): { api: string; media: string } {
  const api = (over.apiUrl || GREEN_API_DEFAULT_HOST).replace(/\/+$/, '');
  return { api, media: (over.mediaUrl || over.apiUrl || GREEN_API_DEFAULT_HOST).replace(/\/+$/, '') };
}

export type InstanceState = 'notAuthorized' | 'authorized' | 'blocked' | 'starting' | 'suspended' | 'pendingPassword' | string;

/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API разбираются вручную */

export class GreenApi {
  readonly http: HttpClient;
  private readonly hosts: { api: string; media: string };

  constructor(
    private readonly creds: GreenApiCredentials,
    opts: HttpOptions = {},
  ) {
    this.http = new HttpClient(opts);
    this.hosts = greenApiHosts(creds.idInstance, creds);
  }

  private url(method: string, media = false): string {
    return `${media ? this.hosts.media : this.hosts.api}/waInstance${encodeURIComponent(this.creds.idInstance)}/${method}/${encodeURIComponent(this.creds.apiTokenInstance)}`;
  }

  /** Вызов метода. Ошибки — ApiError со статусом; в тексте нет адреса (в нём токен). */
  async call<T = any>(method: string, body?: unknown, opts: { get?: boolean; media?: boolean; timeoutMs?: number; signal?: AbortSignal; query?: Record<string, string | number> } = {}): Promise<T> {
    const isForm = body instanceof FormData;
    let url = this.url(method, opts.media);
    if (opts.query) url += `?${new URLSearchParams(Object.fromEntries(Object.entries(opts.query).map(([k, v]) => [k, String(v)])))}`;
    const res = await this.http.call(url, {
      method: opts.get ? 'GET' : 'POST',
      ...(body === undefined || isForm ? {} : { headers: { 'content-type': 'application/json' } }),
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
      timeoutMs: opts.timeoutMs ?? 30_000,
      signal: opts.signal,
    });
    if (res.status >= 400) {
      const j = res.json as { message?: string; error?: string } | string | null;
      const msg = typeof j === 'string' ? j : (j?.message ?? j?.error ?? res.text);
      throw new ApiError(res.status, `GREEN-API ${method}: HTTP ${res.status} ${String(msg ?? '').slice(0, 160)}`.trim(), null);
    }
    return res.json as T;
  }

  getStateInstance(signal?: AbortSignal): Promise<{ stateInstance: InstanceState }> {
    return this.call('getStateInstance', undefined, { get: true, timeoutMs: 15_000, signal });
  }
  getAccountSettings(): Promise<{ phone?: string; stateInstance?: InstanceState; chatId?: string; suspendedUntil?: number; avatar?: string }> {
    return this.call('getAccountSettings', undefined, { get: true, timeoutMs: 15_000 });
  }
  getSettings(): Promise<Record<string, unknown>> {
    return this.call('getSettings', undefined, { get: true, timeoutMs: 15_000 });
  }
  setSettings(settings: Record<string, unknown>): Promise<{ saveSettings?: boolean }> {
    return this.call('setSettings', settings);
  }
  qr(): Promise<{ type: 'qrCode' | 'error' | 'alreadyLogged' | 'already_registered' | string; message: string }> {
    return this.call('qr', undefined, { get: true, timeoutMs: 20_000 });
  }
  checkAccount(phoneDigits: string): Promise<{ exist?: boolean; chatId?: string; status?: boolean; reason?: string }> {
    return this.call('checkAccount', { phoneNumber: Number(phoneDigits) }, { timeoutMs: 30_000 });
  }
  sendMessage(chatId: string, message: string, quotedMessageId?: string | null): Promise<{ idMessage: string }> {
    return this.call('sendMessage', { chatId, message, ...(quotedMessageId ? { quotedMessageId } : {}) }, { timeoutMs: 60_000 });
  }
  sendFileByUpload(chatId: string, data: Buffer, fileName: string, mime: string, caption: string, quotedMessageId?: string | null): Promise<{ idMessage: string }> {
    const form = fileForm('file', data, fileName, mime, { chatId, fileName, ...(caption ? { caption } : {}), ...(quotedMessageId ? { quotedMessageId } : {}) });
    return this.call('sendFileByUpload', form, { media: true, timeoutMs: 180_000 });
  }
  /** Последние count сообщений чата (MAX отдаёт до 5000 сообщений за 3 месяца). */
  getChatHistory(chatId: string, count: number): Promise<unknown[]> {
    return this.call('getChatHistory', { chatId, count }, { timeoutMs: 60_000 });
  }
  sendTyping(chatId: string): Promise<unknown> {
    return this.call('sendTyping', { chatId, typingTime: 3000 }, { timeoutMs: 10_000 });
  }
  receiveNotification(timeoutSec: number, signal?: AbortSignal): Promise<{ receiptId: number; body: unknown } | null> {
    return this.call('receiveNotification', undefined, { get: true, query: { receiveTimeout: timeoutSec }, timeoutMs: (timeoutSec + 15) * 1000, signal });
  }
  /** DELETE {{apiUrl}}/waInstance{{id}}/deleteNotification/{{token}}/{{receiptId}} */
  async deleteNotification(receiptId: number): Promise<unknown> {
    const res = await this.http.call(`${this.url('deleteNotification')}/${receiptId}`, { method: 'DELETE', timeoutMs: 15_000 });
    if (res.status >= 400) throw new ApiError(res.status, `GREEN-API deleteNotification: HTTP ${res.status}`);
    return res.json;
  }
}

/** Разобранное уведомление GREEN-API. */
export type GreenNotification =
  | { kind: 'message'; event: InboundEvent }
  | { kind: 'status'; chatId: string; idMessage: string; status: 'delivered' | 'read' | 'failed' | 'noAccount' | 'notInGroup' | string; description: string }
  | { kind: 'state'; state: InstanceState }
  | { kind: 'skip'; reason: string };

const phoneOf = (n: unknown): string | undefined => {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15 && d !== '0' ? `+${d}` : undefined;
};

function attachmentOf(md: any, idMessage: string): InboundAttachment | null {
  const f = md?.fileMessageData;
  const url = typeof f?.downloadUrl === 'string' ? f.downloadUrl : null;
  if (!url) return null;
  const mime: string = typeof f.mimeType === 'string' ? f.mimeType : '';
  const name: string = typeof f.fileName === 'string' && f.fileName ? f.fileName : '';
  switch (md.typeMessage) {
    case 'imageMessage':
      return { kind: 'picture', ref: url, name: name || `photo_${idMessage}.jpg`, mime: mime || 'image/jpeg' };
    case 'videoMessage':
      return { kind: 'video', ref: url, name: name || `video_${idMessage}.mp4`, mime: mime || 'video/mp4' };
    case 'audioMessage':
      return { kind: /ogg|opus/i.test(mime) || /ptt/i.test(name) ? 'voice' : 'audio', ref: url, name: name || `audio_${idMessage}.${/ogg|opus/i.test(mime) ? 'ogg' : 'mp3'}`, mime: mime || 'audio/mpeg' };
    case 'stickerMessage':
      return { kind: 'sticker', ref: url, name: name || `sticker_${idMessage}.webp`, mime: mime || 'image/webp' };
    case 'documentMessage':
      return { kind: 'file', ref: url, name: name || `file_${idMessage}`, mime: mime || 'application/octet-stream' };
    default:
      return null;
  }
}

/**
 * Уведомление GREEN-API → общее событие. Входящие — от клиента; outgoingMessageReceived — с телефона менеджера
 * (в amoCRM как исходящее); outgoingAPIMessageReceived — наши же отправки через API, пропускаются (иначе дубль).
 */
export function normalizeGreenNotification(body: any): GreenNotification {
  const t = body?.typeWebhook;
  if (t === 'stateInstanceChanged') return { kind: 'state', state: String(body.stateInstance ?? '') };
  if (t === 'outgoingMessageStatus') return { kind: 'status', chatId: String(body.chatId ?? ''), idMessage: String(body.idMessage ?? ''), status: String(body.status ?? ''), description: String(body.description ?? '') };
  if (t === 'outgoingAPIMessageReceived') return { kind: 'skip', reason: 'отправлено через API' };
  if (t !== 'incomingMessageReceived' && t !== 'outgoingMessageReceived') return { kind: 'skip', reason: `тип ${String(t)}` };
  const s = body.senderData ?? {};
  const md = body.messageData ?? {};
  const chatId = String(s.chatId ?? '');
  const idMessage = String(body.idMessage ?? '');
  if (!chatId || !idMessage) return { kind: 'skip', reason: 'нет chatId или idMessage' };
  if (s.chatType === 'channel') return { kind: 'skip', reason: 'канал-лента' };
  const isGroup = s.chatType === 'group' || chatId.startsWith('-');
  const fromMe = t === 'outgoingMessageReceived';
  const attachment = attachmentOf(md, idMessage);
  let text = '';
  let reply: string | null = typeof md.quotedMessage?.stanzaId === 'string' ? md.quotedMessage.stanzaId : null;
  switch (md.typeMessage) {
    case 'textMessage':
      text = String(md.textMessageData?.textMessage ?? '');
      break;
    case 'extendedTextMessage':
      text = String(md.extendedTextMessageData?.text ?? '');
      break;
    case 'quotedMessage':
      text = String(md.extendedTextMessageData?.text ?? '');
      reply = reply ?? (typeof md.extendedTextMessageData?.stanzaId === 'string' ? md.extendedTextMessageData.stanzaId : null);
      break;
    case 'imageMessage':
    case 'videoMessage':
    case 'documentMessage':
    case 'audioMessage':
    case 'stickerMessage':
      text = String(md.fileMessageData?.caption ?? '');
      break;
    case 'locationMessage': {
      const l = md.locationMessageData ?? {};
      text = `Геопозиция: ${[l.nameLocation, l.address].filter(Boolean).join(', ')} https://yandex.ru/maps/?pt=${l.longitude},${l.latitude}&z=16`.replace(':  ', ': ');
      break;
    }
    case 'contactMessage': {
      const c = md.contactMessageData ?? {};
      const tel = /TEL[^:]*:([+\d][\d\s()-]{5,})/i.exec(String(c.vcard ?? ''))?.[1];
      text = `Контакт: ${[c.displayName, tel?.trim()].filter(Boolean).join(' ')}`.trim();
      break;
    }
    case 'reactionMessage':
    case 'pollMessage':
    case 'deletedMessage':
    case 'editedMessage':
      return { kind: 'skip', reason: `тип сообщения ${String(md.typeMessage)}` };
    default:
      text = String(md.textMessageData?.textMessage ?? md.extendedTextMessageData?.text ?? md.fileMessageData?.caption ?? '');
  }
  if (!text && !attachment) return { kind: 'skip', reason: 'пустое сообщение' };
  const senderName = String(s.senderContactName || s.senderName || '').trim();
  const chatName = String(s.chatName || '').trim();
  const phone = isGroup ? undefined : phoneOf(s.senderPhoneNumber);
  const title = isGroup ? chatName || 'Группа MAX' : fromMe ? chatName || phone || chatId : senderName || chatName || phone || chatId;
  return {
    kind: 'message',
    event: {
      externalChatId: chatId,
      chatTitle: title,
      isGroup,
      contact: !isGroup && phone && !fromMe ? { phone } : {},
      author: isGroup && !fromMe ? { id: String(s.sender ?? ''), name: senderName || String(s.sender ?? '') } : null,
      externalMessageId: idMessage,
      text,
      attachment,
      replyToExternalId: reply,
      timestamp: Number(body.timestamp) || Math.floor(Date.now() / 1000),
      fromMe,
    },
  };
}

/**
 * Сообщение из getChatHistory → тот же вид, что у уведомления, и общий разбор.
 * В истории и исходящие через наш API (sendByApi) — это ответы менеджеров из amoCRM; повтор отсеет база по id.
 */
export function normalizeGreenHistoryItem(m: any): InboundEvent | null {
  if (!m || typeof m !== 'object') return null;
  const quoted = typeof m.quotedMessage?.stanzaId === 'string' ? m.quotedMessage.stanzaId : undefined;
  const text = String(m.textMessage ?? m.extendedTextMessage?.text ?? '');
  const body = {
    typeWebhook: m.type === 'outgoing' ? 'outgoingMessageReceived' : 'incomingMessageReceived',
    idMessage: m.idMessage,
    timestamp: m.timestamp,
    senderData: {
      chatId: m.chatId,
      chatType: m.chatType,
      chatName: m.chatName ?? '',
      sender: m.senderId ?? '',
      senderName: m.senderName ?? '',
      senderContactName: m.senderContactName ?? '',
      senderPhoneNumber: m.senderPhoneNumber,
    },
    messageData: {
      typeMessage: m.typeMessage,
      textMessageData: { textMessage: text },
      extendedTextMessageData: { text, ...(quoted ? { stanzaId: quoted } : {}) },
      fileMessageData: { downloadUrl: m.downloadUrl, caption: m.caption ?? '', fileName: m.fileName ?? '', mimeType: m.mimeType ?? '' },
      locationMessageData: m.location ?? m.locationMessageData ?? {},
      contactMessageData: m.contact ?? m.contactMessageData ?? {},
      ...(quoted ? { quotedMessage: { stanzaId: quoted } } : {}),
    },
  };
  const r = normalizeGreenNotification(body);
  return r.kind === 'message' ? r.event : null;
}

/** Состояние инстанса → статус канала и текст для виджета. */
export function channelStatusOf(state: InstanceState, suspendedUntil?: number): { status: 'starting' | 'connected' | 'session_ended' | 'error'; detail: string | null } {
  switch (state) {
    case 'authorized':
      return { status: 'connected', detail: null };
    case 'notAuthorized':
      return { status: 'session_ended', detail: 'Нужен вход по QR: MAX → Настройки → Устройства → Подключить устройство; пароль для входа в MAX должен быть отключён' };
    case 'pendingPassword':
      return { status: 'error', detail: 'MAX запросил пароль входа — отключите пароль в MAX и нажмите «Новый QR»' };
    case 'blocked':
      return { status: 'error', detail: 'Заблокирован: аккаунт MAX получил блокировку' };
    case 'suspended':
      return { status: 'error', detail: `Ограничен (suspended): отправка только на номера из контактов${suspendedUntil ? ` до ${new Date(suspendedUntil * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК` : ''}` };
    case 'starting':
      return { status: 'starting', detail: 'Инстанс GREEN-API запускается (до 5 минут)' };
    default:
      return { status: 'error', detail: `Неизвестное состояние инстанса: ${state || 'пусто'}` };
  }
}

/** Настройки инстанса, которые нужны сервису; сравниваются с текущими, чтобы не перезапускать инстанс без нужды. */
export function desiredSettings(webhookUrl: string | null, webhookToken: string | null): Record<string, string> {
  return {
    webhookUrl: webhookUrl ?? '',
    webhookUrlToken: webhookUrl && webhookToken ? `Bearer ${webhookToken}` : '',
    incomingWebhook: 'yes',
    outgoingMessageWebhook: 'yes',
    outgoingAPIMessageWebhook: 'no',
    outgoingWebhook: 'yes',
    stateWebhook: 'yes',
    markIncomingMessagesReaded: 'no',
  };
}

export function settingsDiffer(current: Record<string, unknown>, desired: Record<string, string>): boolean {
  return Object.entries(desired).some(([k, v]) => String(current[k] ?? '') !== v);
}

/** Проверка заголовка Authorization вебхука: GREEN-API шлёт значение webhookUrlToken как есть («Bearer <секрет>»). */
export function webhookTokenMatches(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const given = header.replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export interface MaxGreenApiDeps extends HttpOptions {
  /** QR для виджета: data:image/png;base64,… или null — убрать. */
  onQr(dataUrl: string | null): Promise<void>;
  /** После входа: номер телефона. false — уже подключён другим каналом. */
  onIdentity(phone: string): Promise<boolean>;
  /** Адрес вебхука и его секрет; пусто — только опрос receiveNotification. */
  webhookUrl?: string;
  webhookToken?: string;
  log?: (level: 'warn' | 'error', msg: string) => void;
  sleep?: typeof pause;
  /** Период проверки состояния инстанса (по умолчанию 60 с) и опроса QR (5 с). */
  stateCheckMs?: number;
  qrPollMs?: number;
}

export class MaxGreenApiConnector implements Connector {
  readonly api: GreenApi;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private sink: ConnectorSink | null = null;
  private state: InstanceState = '';
  private identified = false;
  private settingsApplied = false;
  webhookMode = false;

  constructor(
    creds: GreenApiCredentials,
    private readonly d: MaxGreenApiDeps,
  ) {
    this.api = new GreenApi(creds, d);
  }

  async start(sink: ConnectorSink): Promise<void> {
    this.sink = sink;
    this.loop = this.run(sink);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** Канал удалён: снять наш вебхук с инстанса (сам инстанс и вход не трогаем — он принадлежит заказчику). */
  async logout(): Promise<void> {
    await this.stop();
    if (this.d.webhookUrl) await this.api.setSettings({ webhookUrl: '', webhookUrlToken: '' }).catch(() => undefined);
  }

  private async applyState(sink: ConnectorSink, state: InstanceState): Promise<void> {
    const changed = state !== this.state;
    this.state = state;
    if (state === 'authorized') {
      await this.d.onQr(null);
      if (!this.identified) {
        const acc = await this.api.getAccountSettings().catch(() => null);
        const phone = phoneOf(acc?.phone);
        if (phone) {
          if (!(await this.d.onIdentity(phone))) {
            await sink.status('error', `Номер ${phone} уже подключён другим каналом — удалите один из них`);
            this.abort.abort();
            return;
          }
          this.identified = true;
        }
      }
      if (!this.settingsApplied) await this.ensureSettings();
      await sink.status('connected', this.webhookMode ? null : 'Без вебхука: сообщения забираются опросом');
      return;
    }
    const st = channelStatusOf(state, state === 'suspended' ? (await this.api.getAccountSettings().catch(() => null))?.suspendedUntil : undefined);
    if (changed || state === 'notAuthorized') await sink.status(st.status, st.detail);
  }

  /** webhookUrl и webhookUrlToken — на инстансе; меняем только если отличаются (setSettings перезапускает инстанс). */
  private async ensureSettings(): Promise<void> {
    const desired = desiredSettings(this.d.webhookUrl ?? null, this.d.webhookToken ?? null);
    try {
      const current = await this.api.getSettings();
      if (settingsDiffer(current, desired)) await this.api.setSettings(desired);
      this.webhookMode = Boolean(this.d.webhookUrl);
      this.settingsApplied = true;
    } catch (err) {
      this.d.log?.('warn', `max-greenapi: настройки инстанса не применены (${(err as Error).message}), работает опрос`);
      this.webhookMode = false;
    }
  }

  private async pollQr(sink: ConnectorSink): Promise<void> {
    const r = await this.api.qr().catch((err: Error) => ({ type: 'error', message: err.message }));
    if (r.type === 'qrCode' && r.message) {
      await this.d.onQr(`data:image/png;base64,${r.message}`);
      await sink.status('session_ended', 'Отсканируйте QR: MAX → Настройки → Устройства → Подключить устройство (пароль для входа в MAX должен быть отключён)');
    } else if (r.type === 'alreadyLogged' || r.type === 'already_registered') {
      this.state = '';
    }
  }

  private async run(sink: ConnectorSink): Promise<void> {
    const signal = this.abort.signal;
    const sleep = this.d.sleep ?? pause;
    let failures = 0;
    let lastState = 0;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastState >= (this.d.stateCheckMs ?? 60_000) || !this.state) {
          const { stateInstance } = await this.api.getStateInstance(signal);
          lastState = Date.now();
          await this.applyState(sink, stateInstance);
          failures = 0;
        }
        if (signal.aborted) break;
        if (this.state === 'notAuthorized') {
          await this.pollQr(sink);
          await sleep(this.d.qrPollMs ?? 5000, signal);
          continue;
        }
        if (this.state === 'authorized' && !this.webhookMode) {
          const n = await this.api.receiveNotification(20, signal);
          if (n?.receiptId) {
            await this.onWebhook(n.body).catch((err: Error) => this.d.log?.('error', `max-greenapi: уведомление не обработано: ${err.message}`));
            await this.api.deleteNotification(n.receiptId).catch(() => undefined);
          } else {
            // Очередь пуста: короткая пауза, чтобы не долбить API, если сервер ответил раньше таймаута.
            await sleep(500, signal);
          }
          continue;
        }
        await sleep(Math.min(this.d.stateCheckMs ?? 60_000, 5000), signal);
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403) && !/suspended/i.test(err.message)) {
          await sink.status('error', 'GREEN-API не принял idInstance или apiTokenInstance — проверьте их в console.green-api.com и подключите заново');
          return;
        }
        failures++;
        this.state = '';
        await sink.status('error', 'Нет связи с GREEN-API, повторное подключение').catch(() => undefined);
        this.d.log?.('warn', `max-greenapi: ${(err as Error).message}`);
        await sleep(err instanceof ApiError && err.retryAfter ? err.retryAfter * 1000 : reconnectDelayMs(failures), signal);
      }
    }
  }

  /** Вебхук GREEN-API (токен уже проверен в api) или уведомление из очереди. */
  async onWebhook(body: unknown): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error('Коннектор MAX ещё не запущен');
    const n = normalizeGreenNotification(body);
    switch (n.kind) {
      case 'message':
        return sink.inbound(n.event);
      case 'status':
        if (n.status === 'delivered' || n.status === 'read') return sink.delivery?.(n.chatId, n.idMessage, n.status);
        if (n.status === 'failed' || n.status === 'noAccount' || n.status === 'notInGroup') {
          return sink.sendFailed?.(n.chatId, n.idMessage, n.status === 'noAccount' ? 'У получателя нет аккаунта MAX' : n.status === 'notInGroup' ? 'Отправитель не состоит в группе' : n.description || 'MAX не принял сообщение');
        }
        return;
      case 'state':
        return this.applyState(sink, n.state);
      default:
        return;
    }
  }

  async typing(externalChatId: string): Promise<void> {
    await this.api.sendTyping(externalChatId).catch(() => undefined);
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    try {
      let id: string | null = null;
      if (req.file) {
        const r = await this.api.sendFileByUpload(req.externalChatId, req.file.data, req.file.name, req.file.mime, req.text.slice(0, 4000), req.replyToExternalId);
        id = String(r.idMessage);
        if (req.text.length > 4000) await this.api.sendMessage(req.externalChatId, req.text.slice(4000));
      } else {
        const parts = splitText(req.text, 4000);
        const r = await this.api.sendMessage(req.externalChatId, parts[0] ?? '', req.replyToExternalId);
        id = String(r.idMessage);
        for (const part of parts.slice(1)) await this.api.sendMessage(req.externalChatId, part);
      }
      if (!id) throw new Error('GREEN-API не вернул id сообщения');
      return { externalMessageId: id };
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new PermanentSendError(/suspended/i.test(err.message) ? 'Аккаунт MAX ограничен: отправка только на номера из контактов' : err.message);
      }
      throw err;
    }
  }

  download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    return this.api.http.download(ref, maxBytes);
  }

  /**
   * История чата: GREEN-API отдаёт только последние N сообщений, без «старше чем», поэтому берём с запасом
   * и отсекаем то, что не старше уже известного сообщения. Результат — от старых к новым, не больше limit.
   */
  async history(externalChatId: string, limit: number, before: HistoryCursor | null): Promise<InboundEvent[]> {
    const count = Math.min(5000, before ? limit + 500 : limit);
    const raw = await this.api.getChatHistory(externalChatId, count);
    const seen = new Set<string>();
    const out: InboundEvent[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const ev = normalizeGreenHistoryItem(item);
      if (!ev || ev.externalChatId !== externalChatId || seen.has(ev.externalMessageId)) continue;
      if (before && (ev.timestamp > before.timestamp || ev.externalMessageId === before.externalMessageId)) continue;
      seen.add(ev.externalMessageId);
      out.push(ev);
    }
    return out.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }

  /** «Написать первым»: checkAccount по номеру → chatId. null — на номере нет MAX. */
  async resolvePhone(phone: string): Promise<{ externalChatId: string } | null> {
    const digits = phone.replace(/\D/g, '');
    if (!/^(7\d{10}|375\d{9})$/.test(digits)) throw new Error('MAX через GREEN-API принимает только номера РФ (7…) и РБ (375…)');
    const r = await this.api.checkAccount(digits);
    if (r.status === false) throw new Error(/limit/i.test(r.reason ?? '') ? 'GREEN-API: превышен лимит проверок номеров, повторите через 2 часа' : `GREEN-API: ${r.reason ?? 'инстанс не готов'}`);
    return r.exist && r.chatId ? { externalChatId: String(r.chatId) } : null;
  }
}
