import type { AmojoMessageKind } from '../amojo/client.ts';
import { ApiError, extOf, fileForm, HttpClient, pause, type HttpOptions } from './http.ts';
import { splitText } from './telegram-bot.ts';
import { PermanentSendError, reconnectDelayMs, type Connector, type ConnectorSink, type InboundAttachment, type InboundEvent, type OutboundRequest } from './types.ts';

/**
 * VK (сообщения сообщества): Bots Long Poll API (внешний адрес не нужен), ответ — messages.send с random_id,
 * вложения — через серверы загрузки VK. Ключ доступа сообщества передаётся в теле запроса и не попадает в журнал.
 */
export const VK_API = 'https://api.vk.com/method/';
export const VK_VERSION = '5.199';

/** Коды ошибок VK, после которых запрос повторяется: слишком часто, flood, внутренняя ошибка, неизвестная. */
const VK_RETRY_CODES = new Set([1, 6, 9, 10]);
/** Ключ недействителен или сообщество не то. */
const VK_AUTH_CODES = new Set([5, 27, 28]);
/** Нет прав у ключа (messages, photos, docs) или у сообщества выключены сообщения. */
const VK_PERMISSION_CODES = new Set([7, 15]);
/** Клиент запретил сообщения от сообщества или не писал ему. */
const VK_NO_PERMISSION_TO_WRITE = new Set([901, 902]);

/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API разбираются вручную */

export class VkApi {
  readonly http: HttpClient;

  constructor(
    private readonly token: string,
    opts: HttpOptions = {},
  ) {
    this.http = new HttpClient(opts);
  }

  /** Метод API. Ошибки VK с кодами 1/6/9/10 — как 503, чтобы withRetry повторил; остальные — как 400 с кодом VK. */
  call<T = any>(method: string, params: Record<string, string | number | undefined> = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<T> {
    return this.http.withRetry(async () => {
      const body = new URLSearchParams({ v: VK_VERSION, access_token: this.token });
      for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
      const res = await this.http.request(`${VK_API}${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), timeoutMs, signal });
      const j = res.json as { response?: T; error?: { error_code?: number; error_msg?: string } } | null;
      if (j?.error) {
        const code = Number(j.error.error_code ?? 0);
        const msg = `VK ${code}: ${String(j.error.error_msg ?? 'error').slice(0, 200)}`;
        throw new ApiError(VK_RETRY_CODES.has(code) ? 503 : 400, msg, code, code === 6 || code === 9 ? 1 : null);
      }
      if (!j || !('response' in j)) throw new ApiError(0, 'network error');
      return j.response as T;
    }, signal);
  }

  /** Сообщество, которому принадлежит ключ. */
  async ownGroup(): Promise<{ id: number; name: string; screen_name?: string }> {
    const r = await this.call<any>('groups.getById', {});
    const g = Array.isArray(r) ? r[0] : (r?.groups?.[0] ?? r);
    if (!g?.id) throw new ApiError(400, 'VK: сообщество не найдено', 100);
    return g;
  }

  /** Загрузка на сервер VK: multipart на upload_url, затем сохранение; возвращает строку вложения для messages.send. */
  async uploadPhoto(peerId: string, data: Buffer, name: string, mime: string): Promise<string> {
    const { upload_url } = await this.call<{ upload_url: string }>('photos.getMessagesUploadServer', { peer_id: peerId });
    const up = await this.http.call(upload_url, { method: 'POST', body: fileForm('photo', data, name, mime), timeoutMs: 120_000 });
    const u = up.json as { server?: number; photo?: string; hash?: string } | null;
    if (!u?.photo || u.photo === '[]') throw new Error('VK не принял фото');
    const saved = await this.call<any[]>('photos.saveMessagesPhoto', { server: u.server, photo: u.photo, hash: u.hash });
    const p = saved[0];
    if (!p?.id) throw new Error('VK не сохранил фото');
    return `photo${p.owner_id}_${p.id}${p.access_key ? `_${p.access_key}` : ''}`;
  }

  async uploadDoc(peerId: string, type: 'doc' | 'audio_message', data: Buffer, name: string, mime: string): Promise<string> {
    const { upload_url } = await this.call<{ upload_url: string }>('docs.getMessagesUploadServer', { peer_id: peerId, type });
    const up = await this.http.call(upload_url, { method: 'POST', body: fileForm('file', data, name, mime), timeoutMs: 120_000 });
    const u = up.json as { file?: string } | null;
    if (!u?.file) throw new Error('VK не принял файл');
    const saved = await this.call<any>('docs.save', { file: u.file, title: name });
    const d = saved?.[saved?.type] ?? saved?.doc ?? saved?.audio_message ?? saved;
    if (!d?.id) throw new Error('VK не сохранил файл');
    const prefix = saved?.type === 'audio_message' || saved?.audio_message ? 'audio_message' : 'doc';
    return `${prefix}${d.owner_id}_${d.id}${d.access_key ? `_${d.access_key}` : ''}`;
  }
}

const vkName = (u: any): string => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || `id${u?.id}`;

function attachmentOf(m: any): { attachment: InboundAttachment | null; extraText: string } {
  const list: any[] = Array.isArray(m?.attachments) ? m.attachments : [];
  let attachment: InboundAttachment | null = null;
  const extra: string[] = [];
  const mid = m.id ?? m.conversation_message_id;
  for (const a of list) {
    let next: InboundAttachment | null = null;
    switch (a?.type) {
      case 'photo': {
        const sizes: any[] = Array.isArray(a.photo?.sizes) ? a.photo.sizes : [];
        const best = sizes.reduce((acc, s) => (!acc || (s.width ?? 0) * (s.height ?? 0) > (acc.width ?? 0) * (acc.height ?? 0) ? s : acc), null as any);
        if (best?.url) next = { kind: 'picture', ref: best.url, name: `photo_${mid}.jpg`, mime: 'image/jpeg' };
        break;
      }
      case 'doc':
        if (a.doc?.url) next = { kind: 'file', ref: a.doc.url, name: String(a.doc.title || `file_${mid}.${a.doc.ext ?? 'bin'}`), size: Number(a.doc.size) || undefined };
        break;
      case 'audio_message': {
        const url = a.audio_message?.link_ogg ?? a.audio_message?.link_mp3;
        if (url) next = { kind: 'voice', ref: url, name: `voice_${mid}.${a.audio_message?.link_ogg ? 'ogg' : 'mp3'}`, mime: a.audio_message?.link_ogg ? 'audio/ogg' : 'audio/mpeg' };
        break;
      }
      case 'sticker': {
        const imgs: any[] = Array.isArray(a.sticker?.images) ? a.sticker.images : [];
        const url = imgs.at(-1)?.url;
        if (url) next = { kind: 'sticker', ref: url, name: `sticker_${mid}.png`, mime: 'image/png' };
        break;
      }
      case 'video':
        // Видео VK не отдаётся по прямой ссылке через API сообщества — передаём ссылку на страницу.
        extra.push(`[Видео] https://vk.com/video${a.video?.owner_id}_${a.video?.id}`);
        break;
      case 'link':
        if (a.link?.url) extra.push(a.link.url);
        break;
      case 'wall':
        extra.push(`[Запись] https://vk.com/wall${a.wall?.owner_id ?? a.wall?.from_id}_${a.wall?.id}`);
        break;
      default:
        break;
    }
    if (next && !attachment) attachment = next;
    else if (next) extra.push(next.ref);
  }
  if (m.geo?.coordinates) extra.push(`Геопозиция: https://yandex.ru/maps/?pt=${m.geo.coordinates.longitude},${m.geo.coordinates.latitude}&z=16`);
  return { attachment, extraText: extra.join('\n') };
}

/** Событие Bots Long Poll → общее событие. null — не message_new или служебное. */
export function normalizeVkUpdate(update: any, opts: { userName?: (id: number) => string | undefined; groupTitle?: (peerId: string) => string | undefined } = {}): InboundEvent | null {
  if (update?.type !== 'message_new') return null;
  const m = update.object?.message ?? update.object;
  if (!m?.peer_id || !m.from_id) return null;
  const fromId = Number(m.from_id);
  if (fromId < 0) return null; // от сообщества
  const peerId = String(m.peer_id);
  const isGroup = Number(m.peer_id) > 2_000_000_000;
  const { attachment, extraText } = attachmentOf(m);
  const text = [String(m.text ?? ''), extraText].filter(Boolean).join('\n');
  if (!text && !attachment) return null;
  const name = opts.userName?.(fromId) ?? `id${fromId}`;
  const reply = m.reply_message;
  const replyId = reply ? (Number(reply.id) ? String(reply.id) : reply.conversation_message_id ? `cmid:${reply.conversation_message_id}` : null) : null;
  return {
    externalChatId: peerId,
    chatTitle: isGroup ? (opts.groupTitle?.(peerId) ?? 'Беседа VK') : name,
    isGroup,
    contact: isGroup ? {} : { link: `https://vk.com/id${fromId}` },
    author: isGroup ? { id: String(fromId), name } : null,
    externalMessageId: Number(m.id) ? String(m.id) : `cmid:${m.conversation_message_id}`,
    text,
    attachment,
    replyToExternalId: replyId,
    timestamp: Number(m.date) || Math.floor(Date.now() / 1000),
    fromMe: false,
  };
}

export interface VkConnectorOptions extends HttpOptions {
  onError?: (err: unknown) => void;
  sleep?: typeof pause;
  random?: () => number;
}

export class VkConnector implements Connector {
  readonly api: VkApi;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private readonly names = new Map<number, string>();
  private readonly groupTitles = new Map<string, string>();

  constructor(
    token: string,
    private readonly groupId: number,
    private readonly opts: VkConnectorOptions = {},
  ) {
    this.api = new VkApi(token, opts);
  }

  async start(sink: ConnectorSink): Promise<void> {
    this.loop = this.poll(sink);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async userName(id: number): Promise<string> {
    const cached = this.names.get(id);
    if (cached) return cached;
    const r = await this.api.call<any[]>('users.get', { user_ids: id }).catch(() => []);
    const name = r?.[0] ? vkName(r[0]) : `id${id}`;
    this.names.set(id, name);
    if (this.names.size > 500) this.names.delete(this.names.keys().next().value as number);
    return name;
  }

  private async groupTitle(peerId: string): Promise<void> {
    if (this.groupTitles.has(peerId)) return;
    const r = await this.api.call<any>('messages.getConversationsById', { peer_ids: peerId, group_id: this.groupId }).catch(() => null);
    const title = r?.items?.[0]?.chat_settings?.title;
    if (title) this.groupTitles.set(peerId, title);
  }

  /** Включить Bots Long Poll с событием «Входящее сообщение» (нужны права manage; без них — подсказка в статусе). */
  private async ensureLongPoll(): Promise<void> {
    await this.api.call('groups.setLongPollSettings', { group_id: this.groupId, enabled: 1, api_version: VK_VERSION, message_new: 1 }).catch((err: unknown) => {
      if (err instanceof ApiError && VK_AUTH_CODES.has(Number(err.apiCode))) throw err;
      // Нет прав на настройки — надеемся, что Long Poll включён вручную; ошибка проявится в getLongPollServer.
    });
  }

  private async poll(sink: ConnectorSink): Promise<void> {
    const signal = this.abort.signal;
    const sleep = this.opts.sleep ?? pause;
    let server: { server: string; key: string; ts: string } | null = null;
    let failures = 0;
    let connected = false;
    while (!signal.aborted) {
      try {
        if (!server) {
          await this.ensureLongPoll();
          server = await this.api.call('groups.getLongPollServer', { group_id: this.groupId }, 15_000, signal);
          if (!server?.server) throw new ApiError(400, 'VK: Long Poll не включён', 15);
        }
        const url = new URL(server.server);
        url.searchParams.set('act', 'a_check');
        url.searchParams.set('key', server.key);
        url.searchParams.set('ts', server.ts);
        url.searchParams.set('wait', '25');
        const res = await this.api.http.request(url.toString(), { timeoutMs: 40_000, signal });
        const j = res.json as { ts?: string; updates?: any[]; failed?: number } | null;
        if (!j) throw new ApiError(0, 'network error');
        if (j.failed) {
          // 1 — история устарела (взять новый ts), 2/3 — ключ или сервер устарели.
          if (j.failed === 1 && j.ts) server.ts = String(j.ts);
          else server = null;
          continue;
        }
        if (!connected) {
          await sink.status('connected');
          connected = true;
        }
        failures = 0;
        for (const u of j.updates ?? []) {
          const m = u?.object?.message;
          if (u?.type === 'message_new' && m?.from_id > 0) await this.userName(Number(m.from_id));
          if (u?.type === 'message_new' && Number(m?.peer_id) > 2_000_000_000) await this.groupTitle(String(m.peer_id));
          const ev = normalizeVkUpdate(u, { userName: (id) => this.names.get(id), groupTitle: (p) => this.groupTitles.get(p) });
          if (ev) await sink.inbound(ev);
        }
        // ts двигаем после обработки: при сбое пачка придёт снова, дубли отсечёт БД.
        if (j.ts) server.ts = String(j.ts);
      } catch (err) {
        if (signal.aborted) break;
        const code = err instanceof ApiError ? Number(err.apiCode) : -1;
        if (VK_AUTH_CODES.has(code)) {
          await sink.status('error', 'VK не принял ключ доступа сообщества — создайте новый ключ и подключите заново');
          return;
        }
        if (VK_PERMISSION_CODES.has(code)) {
          await sink.status('error', 'У ключа нет прав: нужны «Сообщения», «Фотографии», «Документы» и «Управление сообществом»; в настройках сообщества включите сообщения и Bots Long Poll API с событием «Входящее сообщение»');
          return;
        }
        failures++;
        connected = false;
        server = null;
        await sink.status('error', 'Нет связи с VK, повторное подключение').catch(() => undefined);
        this.opts.onError?.(err);
        await sleep(reconnectDelayMs(failures), signal);
      }
    }
  }

  async typing(externalChatId: string): Promise<void> {
    await this.api.call('messages.setActivity', { peer_id: externalChatId, type: 'typing', group_id: this.groupId }, 10_000).catch(() => undefined);
  }

  private randomId(): number {
    return Math.floor((this.opts.random ?? Math.random)() * 2_147_483_647);
  }

  private async uploadAttachment(peerId: string, f: NonNullable<OutboundRequest['file']>): Promise<string> {
    const isVoiceOgg = f.kind === 'voice' && /ogg|opus/i.test(f.mime);
    const kind: Exclude<AmojoMessageKind, 'text'> = f.kind;
    if (kind === 'picture' || kind === 'sticker') return this.api.uploadPhoto(peerId, f.data, f.name, f.mime);
    if (isVoiceOgg) return this.api.uploadDoc(peerId, 'audio_message', f.data, f.name, f.mime);
    return this.api.uploadDoc(peerId, 'doc', f.data, f.name || `file.${extOf(f.mime, 'bin')}`, f.mime);
  }

  async send(req: OutboundRequest): Promise<{ externalMessageId: string }> {
    const reply = req.replyToExternalId
      ? req.replyToExternalId.startsWith('cmid:')
        ? { forward: JSON.stringify({ peer_id: Number(req.externalChatId), conversation_message_ids: [Number(req.replyToExternalId.slice(5))], is_reply: true }) }
        : { reply_to: Number(req.replyToExternalId) }
      : {};
    try {
      const parts = splitText(req.text, 4096);
      const attachment = req.file ? await this.uploadAttachment(req.externalChatId, req.file) : undefined;
      // random_id фиксируется на запрос: повтор после сетевого сбоя не создаст дубль у клиента.
      const id = await this.api.call<number | { message_id?: number }[]>('messages.send', {
        peer_id: req.externalChatId,
        random_id: this.randomId(),
        message: parts[0] || undefined,
        attachment,
        ...reply,
      });
      const first = Array.isArray(id) ? id[0]?.message_id : id;
      if (!first) throw new Error('VK не вернул id сообщения');
      for (const part of parts.slice(1)) await this.api.call('messages.send', { peer_id: req.externalChatId, random_id: this.randomId(), message: part });
      return { externalMessageId: String(first) };
    } catch (err) {
      if (err instanceof ApiError && VK_NO_PERMISSION_TO_WRITE.has(Number(err.apiCode))) {
        throw new PermanentSendError('Клиент запретил сообщения от сообщества или ещё не писал ему');
      }
      throw err;
    }
  }

  download(ref: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    return this.api.http.download(ref, maxBytes);
  }
}
