/**
 * Окно переписки в карточке сделки/контакта — как у Wazzup: поверх правой колонки (лента событий),
 * одна лента сообщений, шаблоны по «/», вложения, голосовые, живые обновления по SSE.
 * Все классы с префиксом rfm-cw. Логика рендера вынесена в чистые функции для тестов.
 */
import type { ComposeView, MessengerApi } from './index.ts';
import { renderComposer } from './index.ts';
import { filterTemplates, groupByFolder, renderTemplate, slashQuery, unresolvedVariables, type TemplateContext, type TemplateView } from './templates.ts';

export interface ChatListItem {
  id: number;
  channelId: number;
  kind: string;
  kindText: string;
  channelTitle: string;
  channelConnected: boolean;
  title: string;
  isGroup: boolean;
  contact: { phone?: string; username?: string; link?: string };
  unread: number;
  /** Красный счётчик — входящие без ответа; серый — закрыто последним ответом или «Отвечать не нужно». */
  unanswered?: number;
  answered?: number;
  pinned?: boolean;
  lastAt: string;
  last: { text: string; kind: string; direction: 'in' | 'out'; fileName?: string | null } | null;
  historyAvailable: boolean;
}

export interface ChatsView {
  me: { userId: number; isAdmin: boolean };
  lead: { id: number; name: string; price: number } | null;
  contacts: { id: number; name: string; phones: string[] }[];
  chats: ChatListItem[];
  startChannels: ComposeView['channels'];
  error?: string;
}

export interface MessageView {
  id: number;
  direction: 'in' | 'out';
  source: 'client' | 'amo' | 'phone';
  kind: string;
  text: string;
  at: string;
  status: string;
  error: string | null;
  senderName: string | null;
  author: { id: string; name: string } | null;
  fromHistory: boolean;
  file: { id: string; name: string; mime: string; size: number; url: string } | null;
  replyTo: { id: number; text: string; kind: string; direction: 'in' | 'out'; senderName: string | null } | null;
}

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export type ChatEvent =
  | { type: 'message'; chatId: number; messageId: number }
  | { type: 'status'; chatId: number; messageId: number; status: string; error?: string | null }
  | { type: 'history'; chatId: number; count: number }
  | { type: 'counters'; chatId: number; unanswered: number; answered: number; lastAt?: string };

/** API окна: JSON — через токен amoCRM ($authorizedAjax), файлы и SSE — по сеансу. */
export class ChatApi {
  private sessionToken: string | null = null;

  constructor(
    private readonly api: MessengerApi,
    readonly base: string,
  ) {}

  async session(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    const r = await this.api.call<{ token: string }>('POST', '/chat/v1/session');
    this.sessionToken = r.token;
    return r.token;
  }
  resetSession(): void {
    this.sessionToken = null;
  }
  chats(ctx: { leadId?: number; contactId?: number; chatId?: number }) {
    const qs = ctx.chatId ? `chatId=${ctx.chatId}` : ctx.leadId ? `leadId=${ctx.leadId}` : `contactId=${ctx.contactId ?? 0}`;
    return this.api.call<ChatsView>('GET', `/chat/v1/chats?${qs}`);
  }
  // ---- Раздел «Rf Messenger» ----
  inbox(q: { filter?: string; channelId?: number | null; q?: string; before?: number | null }) {
    const p = new URLSearchParams();
    if (q.filter) p.set('filter', q.filter);
    if (q.channelId) p.set('channelId', String(q.channelId));
    if (q.q) p.set('q', q.q);
    if (q.before) p.set('before', String(q.before));
    return this.api.call<{ me: { userId: number; isAdmin: boolean }; chats: ChatListItem[]; hasMore: boolean; unansweredChats: number }>('GET', `/inbox/v1/chats?${p}`);
  }
  inboxCounters() {
    return this.api.call<{ unansweredChats: number }>('GET', '/inbox/v1/counters');
  }
  inboxChannels() {
    return this.api.call<{ channels: { id: number; kind: string; kindText: string; title: string; connected: boolean }[] }>('GET', '/inbox/v1/channels');
  }
  noReply(chatId: number) {
    return this.api.call<{ ok: boolean; answered: number; unansweredChats: number }>('POST', `/inbox/v1/chats/${chatId}/no-reply`);
  }
  pin(chatId: number, pinned: boolean) {
    return this.api.call<{ ok: boolean }>('POST', `/inbox/v1/chats/${chatId}/pin`, { pinned });
  }
  searchContacts(q: string) {
    return this.api.call<{ contacts: { id: number; name: string; phones: string[] }[] }>('GET', `/inbox/v1/contacts/search?q=${encodeURIComponent(q)}`);
  }
  linkContact(chatId: number, contactId: number) {
    return this.api.call<{ ok: boolean }>('POST', `/inbox/v1/chats/${chatId}/link-contact`, { contactId });
  }
  createLead(chatId: number, body: { contactId?: number; name?: string } = {}) {
    return this.api.call<{ ok: boolean; contactId: number; leadId: number }>('POST', `/inbox/v1/chats/${chatId}/lead`, body);
  }
  messages(chatId: number, before?: number) {
    return this.api.call<{ messages: MessageView[]; hasMore: boolean }>('GET', `/chat/v1/chats/${chatId}/messages${before ? `?before=${before}` : ''}`);
  }
  search(chatId: number, q: string) {
    return this.api.call<{ messages: MessageView[] }>('GET', `/chat/v1/chats/${chatId}/search?q=${encodeURIComponent(q)}`);
  }
  send(chatId: number, body: { text: string; replyToMessageId?: number | null; fileIds?: string[] }) {
    return this.api.call<{ messages: MessageView[] }>('POST', `/chat/v1/chats/${chatId}/messages`, body);
  }
  read(chatId: number) {
    return this.api.call<{ ok: boolean }>('POST', `/chat/v1/chats/${chatId}/read`);
  }
  history(chatId: number) {
    return this.api.call<{ queued: boolean }>('POST', `/chat/v1/chats/${chatId}/history`);
  }
  retry(messageId: number) {
    return this.api.call<{ queued: boolean }>('POST', `/chat/v1/messages/${messageId}/retry`);
  }
  contactLeads(contactId: number) {
    return this.api.call<{ leads: { id: number; name: string; price: number }[] }>('GET', `/chat/v1/contacts/${contactId}/leads`);
  }
  templates() {
    return this.api.call<{ templates: TemplateView[] }>('GET', '/chat/v1/templates');
  }
  templateContext(ctx: { leadId?: number; contactId?: number }) {
    const qs = ctx.leadId ? `leadId=${ctx.leadId}` : `contactId=${ctx.contactId ?? 0}`;
    return this.api.call<TemplateContext>('GET', `/chat/v1/templates/context?${qs}`);
  }
  createTemplate(body: Partial<TemplateView>) {
    return this.api.call<TemplateView>('POST', '/chat/v1/templates', body);
  }
  updateTemplate(id: number, body: Partial<TemplateView>) {
    return this.api.call<TemplateView>('PUT', `/chat/v1/templates/${id}`, body);
  }
  deleteTemplate(id: number) {
    return this.api.call<{ deleted: boolean }>('DELETE', `/chat/v1/templates/${id}`);
  }
  usedTemplate(id: number) {
    return this.api.call<{ ok: boolean }>('POST', `/chat/v1/templates/${id}/used`).catch(() => ({ ok: false }));
  }
  startChat(body: { channelId: number; contactId: number; phone?: string; chatId?: number; text: string }) {
    return this.api.call<{ chatId: number; messageId: number }>('POST', '/widget/v1/chats/start', body);
  }

  /** Загрузка файла: multipart по сеансу (через $authorizedAjax файл не отправить). */
  async upload(file: Blob, name: string, w: Window = window): Promise<UploadedFile> {
    const token = await this.session();
    const form = new FormData();
    form.set('file', file, name);
    const res = await w.fetch(new URL('/chat/v1/files', this.base).toString(), { method: 'POST', headers: { 'x-rfm-session': token }, body: form });
    if (res.status === 401) this.resetSession();
    const body = (await res.json().catch(() => ({}))) as { error?: string } & UploadedFile;
    if (!res.ok) throw new Error(body.error ?? `Файл не загружен (HTTP ${res.status})`);
    return body;
  }

  /** Живые события по SSE. */
  async events(chatIds: number[], onEvent: (ev: ChatEvent) => void, w: Window = window, scope?: 'inbox'): Promise<() => void> {
    const token = await this.session();
    const url = new URL('/chat/v1/events', this.base);
    url.searchParams.set('session', token);
    url.searchParams.set('chats', chatIds.join(','));
    if (scope) url.searchParams.set('scope', scope);
    const ES = (w as unknown as { EventSource?: typeof EventSource }).EventSource;
    if (!ES) return () => undefined;
    const es = new ES(url.toString());
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(e.data) as ChatEvent);
      } catch {
        // мусор в потоке игнорируем
      }
    };
    return () => es.close();
  }
}

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENT[c] ?? c);

/** Текст сообщения: экранирован, ссылки кликабельны, переносы сохранены. */
export function richText(text: string): string {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/\n/g, '<br>');
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Подпись дня для разделителя: Сегодня, Вчера, 5 ноября, 5 ноября 2025. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Сегодня';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return 'Вчера';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export const KIND_ICON: Record<string, string> = { whatsapp: 'W', telegram_bot: 'T', telegram_user: 'T', max: 'M', max_phone: 'M', vk: 'VK', avito: 'A' };
const KIND_CLASS: Record<string, string> = { whatsapp: 'rfm-wa', telegram_bot: 'rfm-tg', telegram_user: 'rfm-tg', max: 'rfm-max', max_phone: 'rfm-max', vk: 'rfm-vk', avito: 'rfm-av' };
export const kindBadge = (kind: string) => `<span class="rfm-cw-badge ${KIND_CLASS[kind] ?? 'rfm-off'}" title="${esc(kind)}">${KIND_ICON[kind] ?? '?'}</span>`;

/** Подпись статуса исходящего. */
export function statusMark(m: Pick<MessageView, 'status' | 'direction' | 'source'>): { text: string; title: string; cls: string } {
  if (m.direction !== 'out') return { text: '', title: '', cls: '' };
  switch (m.status) {
    case 'queued':
    case 'received':
      return { text: '🕓', title: 'Отправляется', cls: 'rfm-cw-st-wait' };
    case 'sent':
    case 'synced':
      return { text: '✓', title: 'Отправлено', cls: '' };
    case 'delivered':
      return { text: '✓✓', title: 'Доставлено', cls: '' };
    case 'read':
      return { text: '✓✓', title: 'Прочитано', cls: 'rfm-cw-st-read' };
    case 'failed':
      return { text: '!', title: 'Не доставлено', cls: 'rfm-cw-st-fail' };
    default:
      return { text: '', title: '', cls: '' };
  }
}

const sizeLabel = (n: number) => (n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${Math.round(n / 1024)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);

function attachmentHtml(m: MessageView): string {
  const f = m.file;
  if (!f) return m.kind !== 'text' ? `<div class="rfm-cw-file rfm-cw-file-missing">Вложение (${esc(m.kind)}) не получено</div>` : '';
  if (m.kind === 'picture' || m.kind === 'sticker') return `<a class="rfm-cw-img" href="${esc(f.url)}" data-cw="lightbox" data-url="${esc(f.url)}"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"></a>`;
  if (m.kind === 'video') return `<video class="rfm-cw-video" src="${esc(f.url)}" controls preload="metadata" data-cw="lightbox-video" data-url="${esc(f.url)}"></video>`;
  if (m.kind === 'voice' || m.kind === 'audio') return `<div class="rfm-cw-audio">${m.kind === 'voice' ? '🎤 ' : ''}<audio src="${esc(f.url)}" controls preload="none"></audio></div>`;
  return `<a class="rfm-cw-file" href="${esc(f.url)}" target="_blank" rel="noopener" download="${esc(f.name)}">📄 <span>${esc(f.name)}</span><small>${sizeLabel(f.size)}</small></a>`;
}

export function messageHtml(m: MessageView, opts: { isGroup?: boolean } = {}): string {
  const out = m.direction === 'out';
  const st = statusMark(m);
  const who = out ? (m.senderName ?? (m.source === 'amo' ? 'amoCRM' : 'Менеджер')) : opts.isGroup && m.author ? m.author.name : '';
  const quote = m.replyTo
    ? `<div class="rfm-cw-quote" data-cw="jump" data-id="${m.replyTo.id}"><b>${esc(m.replyTo.direction === 'out' ? (m.replyTo.senderName ?? 'Менеджер') : 'Клиент')}</b><div>${esc(m.replyTo.text || `[${m.replyTo.kind}]`).slice(0, 160)}</div></div>`
    : '';
  const retry = m.status === 'failed' && m.source === 'amo' ? `<button type="button" class="rfm-cw-retry" data-cw="retry" data-id="${m.id}">Повторить</button>` : '';
  const err = m.status === 'failed' && m.error ? `<div class="rfm-cw-err">${esc(m.error)}</div>` : '';
  return `<div class="rfm-cw-msg ${out ? 'rfm-cw-out' : 'rfm-cw-in'}${m.fromHistory ? ' rfm-cw-hist' : ''}" data-id="${m.id}" data-at="${esc(m.at)}">
<div class="rfm-cw-bubble">
${who ? `<div class="rfm-cw-who">${esc(who)}</div>` : ''}${quote}${attachmentHtml(m)}<div class="rfm-cw-content">${m.text ? `<div class="rfm-cw-text">${richText(m.text)}<span class="rfm-cw-sp${st.text ? ' rfm-cw-sp-st' : ''}" aria-hidden="true"></span></div>` : ''}
<div class="rfm-cw-meta${m.text ? '' : ' rfm-cw-meta-block'}"><span>${timeLabel(m.at)}</span>${st.text ? `<span class="rfm-cw-st ${st.cls}" title="${st.title}">${st.text}</span>` : ''}</div></div>${err}${retry}
<button type="button" class="rfm-cw-reply" data-cw="reply" data-id="${m.id}" title="Ответить">↩</button>
</div></div>`;
}

/** Лента: разделители дат между сообщениями разных дней. */
export function messagesHtml(list: readonly MessageView[], opts: { isGroup?: boolean; now?: Date } = {}): string {
  let lastDay = '';
  let html = '';
  for (const m of list) {
    const day = dayLabel(m.at, opts.now);
    if (day !== lastDay) {
      html += `<div class="rfm-cw-day"><span>${day}</span></div>`;
      lastDay = day;
    }
    html += messageHtml(m, opts);
  }
  return html;
}

const lastPreview = (c: ChatListItem) => (c.last ? (c.last.text ? c.last.text : `[${c.last.kind}]`) : '');

export function chatListHtml(chats: readonly ChatListItem[], currentId: number | null): string {
  if (!chats.length) return '<div class="rfm-cw-empty">Чатов с этим контактом пока нет</div>';
  return chats
    .map(
      (c) => `<button type="button" class="rfm-cw-item${c.id === currentId ? ' rfm-cw-item-on' : ''}" data-cw="open" data-id="${c.id}">
${kindBadge(c.kind)}<span class="rfm-cw-item-main"><b>${esc(c.title)}</b><small>${esc(c.contact.phone ?? (c.contact.username ? `@${c.contact.username}` : c.channelTitle))}</small><small class="rfm-cw-item-last">${esc(lastPreview(c)).slice(0, 80)}</small></span>
<span class="rfm-cw-item-side"><small>${timeLabel(c.lastAt)}</small>${c.unread ? `<i class="rfm-cw-unread">${c.unread}</i>` : ''}</span></button>`,
    )
    .join('');
}

export function templatesPopoverHtml(list: readonly TemplateView[], query: string, active: number): string {
  const found = filterTemplates(list, query);
  if (!list.length) return '<div class="rfm-cw-pop"><div class="rfm-cw-empty">Шаблонов пока нет. Добавьте их: ⋮ → «Мои шаблоны» (личные) или в настройках виджета (общие).</div></div>';
  if (!found.length) return `<div class="rfm-cw-pop"><div class="rfm-cw-empty">Ничего не найдено по «${esc(query)}»</div></div>`;
  let i = 0;
  const groups = groupByFolder(found)
    .map(
      (g) =>
        `<div class="rfm-cw-pop-folder">${esc(g.folder)}</div>` +
        g.items
          .map((t) => {
            const idx = i++;
            return `<button type="button" class="rfm-cw-pop-item${idx === active ? ' rfm-cw-pop-on' : ''}" data-cw="tpl" data-id="${t.id}" data-idx="${idx}"><b>${esc(t.title)}</b>${t.attachments.length ? ` <small>📎 ${t.attachments.length}</small>` : ''}<small>${esc(t.text).slice(0, 90)}</small></button>`;
          })
          .join(''),
    )
    .join('');
  return `<div class="rfm-cw-pop"><div class="rfm-cw-pop-head">Шаблоны${query ? ` · поиск «${esc(query)}»` : ''}<small>↑↓ выбрать, Enter — вставить, Esc — закрыть</small></div>${groups}</div>`;
}

export const EMOJI = ['😀', '😊', '😉', '😂', '🙂', '😍', '🤔', '😎', '🙏', '👍', '👌', '🤝', '👋', '💪', '🎉', '✅', '❗', '❓', '⭐', '🔥', '❤️', '💬', '📞', '📍', '🕒', '📅', '🚪', '🔑', '🏠', '🛠️', '📦', '🚚', '💳', '💰', '📄', '✍️', '📷', '🎁', '☀️', '🌙'];

export const CW_CSS = `
.rfm-cw{position:fixed;z-index:9000;background:#f3f5f8;display:flex;flex-direction:column;font:13px/1.45 'Open Sans','PT Sans',Arial,sans-serif;color:#2e3640;box-shadow:-6px 0 18px rgba(0,0,0,.08);min-width:360px}
.rfm-cw *{box-sizing:border-box}
.rfm-cw button{font:inherit;color:inherit;cursor:pointer}
.rfm-cw-tab{position:absolute;right:-28px;top:16px;width:28px;height:44px;background:#25c25a;color:#fff;border-radius:0 8px 8px 0;border:0;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:2px 2px 8px rgba(0,0,0,.15)}
.rfm-cw-tab:hover{background:#1fa94d}
.rfm-cw-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#fff;border-bottom:1px solid #e1e5e9;flex:none}
.rfm-cw-ib{width:32px;height:32px;border:0;background:transparent;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;color:#5f6b78}
.rfm-cw-ib:hover{background:#eef2f6}
.rfm-cw-title{flex:1;min-width:0;display:flex;flex-direction:column}
.rfm-cw-title b{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-cw-title small{display:flex;align-items:center;gap:6px;color:#6b7785;font-size:12px}
.rfm-cw-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:10px;font-weight:700;flex:none}
.rfm-wa{background:#e6f6ea;color:#1f8f3a}.rfm-tg{background:#e6f1fb;color:#1e6fb8}.rfm-max{background:#ebe7fb;color:#5b3fd1}.rfm-vk{background:#e4eefb;color:#0a5fd6}.rfm-av{background:#e6f4ec;color:#0f8a4b}.rfm-off{background:#f1f3f5;color:#9aa5b1}
.rfm-cw-btn{height:30px;padding:0 10px;border:1px solid #cfd7df;border-radius:6px;background:#fff;font-size:12px;white-space:nowrap}
.rfm-cw-btn:hover{background:#f5f7f9}
.rfm-cw-btn-primary{background:#4c8bf5;border-color:#4c8bf5;color:#fff}
.rfm-cw-body{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:4px;background:#eef1f5}
.rfm-cw-loading{text-align:center;color:#8a96a3;font-size:12px;padding:6px}
.rfm-cw-day{display:flex;justify-content:center;margin:10px 0 6px;position:sticky;top:0;z-index:1}
.rfm-cw-day span{background:rgba(0,0,0,.22);color:#fff;font-size:12px;font-weight:500;padding:3px 10px;border-radius:999px}
.rfm-cw-msg{display:flex;max-width:100%;margin:1px 0}
.rfm-cw-in{justify-content:flex-start}.rfm-cw-out{justify-content:flex-end}
.rfm-cw-bubble{position:relative;max-width:78%;background:#fff;border-radius:14px 14px 14px 4px;padding:6px 10px 6px;box-shadow:0 1px 1px rgba(0,0,0,.08);word-wrap:break-word;overflow-wrap:anywhere;font-size:15px;line-height:1.4;color:#0b141a}
.rfm-cw-out .rfm-cw-bubble{background:#e3f6d2;border-radius:14px 14px 4px 14px}
.rfm-cw-hist .rfm-cw-bubble{opacity:.92}
.rfm-cw-who{font-size:13px;font-weight:700;color:#2f6fd6;margin-bottom:2px}
.rfm-cw-in .rfm-cw-who{color:#c0592b}
.rfm-cw-out .rfm-cw-who{color:#3a8a3e}
.rfm-cw-text a{color:#2f6fd6}
.rfm-cw-content{position:relative}
.rfm-cw-sp{display:inline-block;width:40px;height:1px}.rfm-cw-sp-st{width:58px}
.rfm-cw-meta{position:absolute;right:-2px;bottom:-3px;display:flex;align-items:center;gap:3px;font-size:11.5px;font-weight:500;line-height:1;color:#7a8692;white-space:nowrap;user-select:none}
.rfm-cw-meta-block{position:static;justify-content:flex-end;margin-top:3px}
.rfm-cw-out .rfm-cw-meta{color:#5fa565}
.rfm-cw-st{font-size:12px;letter-spacing:-3px;padding-right:3px}
.rfm-cw-st-read{color:#3a9bec}.rfm-cw-st-fail{color:#c0392b;font-weight:700;letter-spacing:0}.rfm-cw-st-wait{opacity:.7}
.rfm-cw-err{font-size:11px;color:#c0392b;margin-top:2px}
.rfm-cw-retry{border:0;background:transparent;color:#2f6fd6;font-size:11px;padding:0;text-decoration:underline}
.rfm-cw-reply{position:absolute;top:2px;right:-30px;width:26px;height:26px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);display:none;font-size:13px;color:#5f6b78}
.rfm-cw-out .rfm-cw-reply{right:auto;left:-30px}
.rfm-cw-msg:hover .rfm-cw-reply{display:flex;align-items:center;justify-content:center}
.rfm-cw-quote{border-left:3px solid #4c8bf5;background:rgba(0,0,0,.04);padding:4px 8px;border-radius:4px;margin-bottom:4px;font-size:12px;cursor:pointer}
.rfm-cw-quote b{display:block;font-size:11px;color:#2f6fd6}
.rfm-cw-img{display:block;margin:2px 0}
.rfm-cw-img img{max-width:260px;max-height:260px;border-radius:8px;display:block;cursor:zoom-in}
.rfm-cw-video{max-width:280px;border-radius:8px;display:block}
.rfm-cw-audio{display:flex;align-items:center;gap:4px}.rfm-cw-audio audio{height:32px;max-width:240px}
.rfm-cw-file{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid #e1e5e9;border-radius:8px;background:#fafbfc;color:inherit;text-decoration:none;font-size:12px}
.rfm-cw-file small{color:#8a96a3}
.rfm-cw-file-missing{color:#8a96a3;font-style:italic}
.rfm-cw-foot{flex:none;background:#fff;border-top:1px solid #e1e5e9;padding:8px 10px}
.rfm-cw-row{display:flex;align-items:flex-end;gap:6px}
.rfm-cw-clip{width:38px;height:38px;font-size:18px;color:#8e99a4}
.rfm-cw-field{flex:1;min-width:0;display:flex;align-items:flex-end;gap:2px;background:#f1f3f5;border:1px solid transparent;border-radius:20px;padding:2px 4px}
.rfm-cw-field:focus-within{border-color:#b9cdf0;background:#fff}
.rfm-cw-field .rfm-cw-ib{width:32px;height:32px;border-radius:50%;flex:none;color:#8e99a4}
.rfm-cw-slash{font-weight:700}
.rfm-cw-ta{flex:1;min-width:0;min-height:32px;max-height:160px;resize:none;border:0;background:transparent;padding:7px 4px;font:inherit;font-size:15px;color:#111b21;line-height:1.3}
.rfm-cw-ta:focus{outline:none}
.rfm-cw-round{width:38px;height:38px;flex:none;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px}
.rfm-cw-mic{background:transparent;color:#8e99a4}.rfm-cw-mic:hover{background:#eef2f6}
.rfm-cw-send{display:none;background:#4c8bf5;color:#fff}
.rfm-cw-send:disabled{background:#c5d5f3}
.rfm-cw-typing .rfm-cw-send{display:flex}.rfm-cw-typing .rfm-cw-mic{display:none}
.rfm-cw-replybar,.rfm-cw-warn{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;border-radius:6px;margin-bottom:6px}
.rfm-cw-replybar{background:#eef3fb;border-left:3px solid #4c8bf5}
.rfm-cw-replybar span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-cw-warn{background:#fff6e5;color:#8a5a00}
.rfm-cw-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.rfm-cw-chip{display:flex;align-items:center;gap:6px;background:#eef2f6;border-radius:6px;padding:4px 8px;font-size:12px;max-width:240px}
.rfm-cw-chip img{width:28px;height:28px;object-fit:cover;border-radius:4px}
.rfm-cw-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-cw-chip button{border:0;background:transparent;color:#8a96a3;padding:0 2px}
.rfm-cw-rec{display:flex;align-items:center;gap:10px;font-size:13px;color:#c0392b}
.rfm-cw-rec i{width:10px;height:10px;border-radius:50%;background:#c0392b;animation:rfmblink 1s infinite}
@keyframes rfmblink{50%{opacity:.2}}
.rfm-cw-pop{position:absolute;left:8px;right:8px;bottom:62px;max-height:60%;overflow:auto;background:#fff;border:1px solid #cfd7df;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);z-index:2;padding:6px}
.rfm-cw-pop-head{font-size:12px;color:#6b7785;padding:4px 8px;display:flex;justify-content:space-between;gap:8px}
.rfm-cw-pop-folder{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8a96a3;padding:8px 8px 2px}
.rfm-cw-pop-item{display:flex;flex-direction:column;align-items:flex-start;width:100%;border:0;background:transparent;border-radius:6px;padding:6px 8px;text-align:left}
.rfm-cw-pop-item small{color:#6b7785;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.rfm-cw-pop-item:hover,.rfm-cw-pop-on{background:#eef3fb}
.rfm-cw-emoji{display:grid;grid-template-columns:repeat(10,1fr);gap:2px}
.rfm-cw-emoji button{border:0;background:transparent;font-size:20px;padding:4px;border-radius:6px}
.rfm-cw-emoji button:hover{background:#eef2f6}
.rfm-cw-drawer{position:absolute;inset:0;background:#fff;z-index:3;display:flex;flex-direction:column}
.rfm-cw-drawer-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #e1e5e9;font-weight:600}
.rfm-cw-list{flex:1;overflow:auto}
.rfm-cw-item{display:flex;align-items:center;gap:10px;width:100%;border:0;border-bottom:1px solid #eef1f5;background:#fff;padding:10px 12px;text-align:left}
.rfm-cw-item:hover,.rfm-cw-item-on{background:#f2f7ff}
.rfm-cw-item-main{flex:1;min-width:0;display:flex;flex-direction:column}
.rfm-cw-item-main b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-cw-item-main small{color:#6b7785;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-cw-item-side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;color:#8a96a3;font-size:11px}
.rfm-cw-unread{font-style:normal;background:#25c25a;color:#fff;border-radius:999px;padding:1px 7px;font-size:11px;font-weight:600}
.rfm-cw-empty{padding:18px;text-align:center;color:#8a96a3;font-size:13px}
.rfm-cw-menu{position:absolute;right:10px;top:46px;background:#fff;border:1px solid #cfd7df;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);z-index:4;min-width:220px;padding:4px}
.rfm-cw-menu button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:8px 12px;border-radius:6px}
.rfm-cw-menu button:hover{background:#eef2f6}
.rfm-cw-search{display:flex;gap:6px;padding:6px 10px;background:#fff;border-bottom:1px solid #e1e5e9}
.rfm-cw-search input{flex:1;height:30px;border:1px solid #cfd7df;border-radius:6px;padding:0 10px;font:inherit}
.rfm-cw-found{background:#fff;border-bottom:1px solid #e1e5e9;max-height:40%;overflow:auto}
.rfm-cw-found button{display:block;width:100%;border:0;border-bottom:1px solid #eef1f5;background:#fff;text-align:left;padding:6px 12px;font-size:12px}
.rfm-cw-found button:hover{background:#f2f7ff}
.rfm-cw-light{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10001;display:flex;align-items:center;justify-content:center;cursor:zoom-out}
.rfm-cw-light img,.rfm-cw-light video{max-width:94vw;max-height:94vh;border-radius:6px}
.rfm-cw-compose{padding:16px;overflow:auto}
.rfm-cw-compose .rfm-modal{width:100%;box-shadow:none;border:1px solid #e1e5e9}
.rfm-cw-mark{outline:2px solid #ffb84d;border-radius:10px}
.rfm-cw-embed{position:static!important;width:100%!important;height:100%!important;box-shadow:none;min-width:0}
.rfm-cw-embed .rfm-cw-tab{display:none}
.rfm-cw-noreply{display:flex;justify-content:center;padding:6px 0 2px}
.rfm-cw-noreply button{background:#e5484d;color:#fff;border:0;border-radius:999px;padding:7px 16px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;box-shadow:0 2px 6px rgba(229,72,77,.3)}
.rfm-cw-noreply button i{font-style:normal;background:#fff;color:#e5484d;border-radius:999px;padding:0 7px;font-size:11px}
.rfm-cw-contactbox{padding:8px;display:flex;flex-direction:column;gap:6px}
.rfm-cw-contactbox input{height:30px;border:1px solid #cfd7df;border-radius:6px;padding:0 10px;font:inherit}
.rfm-cw-drop{outline:3px dashed #4c8bf5;outline-offset:-6px}
`;

/** Селекторы правой колонки карточки amoCRM (лента / чат). Первый найденный — под окно; иначе правая часть экрана. */
export const RIGHT_COLUMN_SELECTORS = ['.card-holder__right', '.card-holder .notes-wrapper', '.card-fields__right', '#card_holder .card-holder__content_right', '.feed-wrapper'];

export function findRightColumn(doc: Document): HTMLElement | null {
  for (const sel of RIGHT_COLUMN_SELECTORS) {
    const el = doc.querySelector<HTMLElement>(sel);
    if (el && el.getBoundingClientRect().width > 300) return el;
  }
  return null;
}

/** Положение окна: над правой колонкой или, если её не нашли, правые 58 % экрана. */
export function placeWindow(win: HTMLElement, column: HTMLElement | null, w: Window): void {
  if (column) {
    const r = column.getBoundingClientRect();
    Object.assign(win.style, { left: `${Math.max(0, r.left)}px`, top: `${Math.max(0, r.top)}px`, width: `${Math.max(360, Math.min(r.width, w.innerWidth - r.left - 30))}px`, height: `${Math.max(300, Math.min(r.height, w.innerHeight - r.top))}px` });
  } else {
    const left = Math.round(w.innerWidth * 0.42);
    Object.assign(win.style, { left: `${left}px`, top: '0px', width: `${w.innerWidth - left - 30}px`, height: `${w.innerHeight}px` });
  }
}

export interface OpenOptions {
  ctx: { leadId?: number; contactId?: number; chatId?: number };
  doc?: Document;
  win?: Window;
  /** Открыть сразу этот чат. */
  chatId?: number;
  /** Раздел «Rf Messenger»: окно встраивается в этот элемент (без вкладки закрытия и ☰), события SSE ведёт раздел. */
  embed?: HTMLElement;
  /** Раздел сообщает о смене счётчиков чата и об отправке (чтобы обновить список). */
  onCounters?: (chatId: number, unanswered: number, answered: number) => void;
  onSent?: (chatId: number) => void;
}

/** Разметка каркаса окна. */
export function frameHtml(): string {
  return `<style>${CW_CSS}</style>
<button type="button" class="rfm-cw-tab" data-cw="close" title="Закрыть (Esc)">×</button>
<div class="rfm-cw-head">
  <button type="button" class="rfm-cw-ib" data-cw="list" title="Все чаты контакта">☰</button>
  <div class="rfm-cw-title" data-cw-title><b>Переписка</b><small>Загрузка…</small></div>
  <button type="button" class="rfm-cw-ib" data-cw="search" title="Поиск по переписке">🔍</button>
  <button type="button" class="rfm-cw-ib" data-cw="contact" title="Добавить или привязать контакт" style="display:none">👤+</button>
  <button type="button" class="rfm-cw-btn" data-cw="deals">Сделки ▾</button>
  <button type="button" class="rfm-cw-ib" data-cw="menu" title="Ещё">⋮</button>
</div>
<div data-cw-search></div>
<div class="rfm-cw-body" data-cw-body><div class="rfm-cw-loading">Загрузка…</div></div>
<div class="rfm-cw-foot" data-cw-foot style="display:none">
  <div data-cw-reply></div><div data-cw-warn></div><div class="rfm-cw-chips" data-cw-chips></div>
  <div class="rfm-cw-row" data-cw-row>
    <button type="button" class="rfm-cw-ib rfm-cw-clip" data-cw="attach" title="Вложение (фото, файл)">📎</button>
    <div class="rfm-cw-field">
      <button type="button" class="rfm-cw-ib" data-cw="emoji" title="Эмодзи">😊</button>
      <textarea class="rfm-cw-ta" data-cw-ta rows="1" placeholder="Сообщение"></textarea>
      <button type="button" class="rfm-cw-ib rfm-cw-slash" data-cw="slash" title="Шаблоны">/</button>
    </div>
    <button type="button" class="rfm-cw-round rfm-cw-mic" data-cw="mic" title="Голосовое сообщение">🎤</button>
    <button type="button" class="rfm-cw-round rfm-cw-send" data-cw="send" title="Отправить (Enter)">➤</button>
  </div>
  <input type="file" data-cw-file multiple style="display:none">
</div>
<div data-cw-pop></div><div data-cw-overlay></div>`;
}

type Recorder = { stop(): void; state: string; ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null; start(): void; mimeType: string };

/** Открывает окно переписки поверх правой колонки карточки. Возвращает функцию закрытия. */
export async function openChatWindow(chat: ChatApi, o: OpenOptions): Promise<() => void> {
  const doc = o.doc ?? document;
  const w = o.win ?? window;
  const embed = o.embed ?? null;
  if (!embed) doc.querySelector<HTMLElement>('.rfm-cw')?.remove();
  const win = doc.createElement('div');
  win.className = embed ? 'rfm-cw rfm-cw-embed' : 'rfm-cw';
  win.innerHTML = frameHtml();
  if (embed) {
    embed.innerHTML = '';
    embed.appendChild(win);
    win.querySelector<HTMLElement>('[data-cw="list"]')?.style.setProperty('display', 'none');
    win.querySelector<HTMLElement>('[data-cw="contact"]')?.style.setProperty('display', '');
  } else doc.body.appendChild(win);
  const column = embed ? null : findRightColumn(doc);
  const reposition = () => {
    if (!embed) placeWindow(win, column, w);
  };
  reposition();
  if (!embed) {
    w.addEventListener('resize', reposition);
    w.addEventListener('scroll', reposition, true);
  }
  const ro = !embed && typeof ResizeObserver !== 'undefined' && column ? new ResizeObserver(reposition) : null;
  ro?.observe(column as Element);

  const q = <T extends HTMLElement>(sel: string) => win.querySelector<T>(sel) as T;
  const body = q<HTMLElement>('[data-cw-body]');
  const foot = q<HTMLElement>('[data-cw-foot]');
  const ta = q<HTMLTextAreaElement>('[data-cw-ta]');
  const pop = q<HTMLElement>('[data-cw-pop]');
  const overlay = q<HTMLElement>('[data-cw-overlay]');
  const fileInput = q<HTMLInputElement>('[data-cw-file]');

  let view: ChatsView | null = null;
  let current: ChatListItem | null = null;
  let messages: MessageView[] = [];
  let hasMore = false;
  let loadingMore = false;
  let replyTo: MessageView | null = null;
  let attachments: UploadedFile[] = [];
  let templates: TemplateView[] | null = null;
  let tplCtx: TemplateContext | null = null;
  let tplActive = 0;
  let recorder: Recorder | null = null;
  let stopEvents: (() => void) | null = null;
  let closed = false;

  const setTitle = (title: string, sub: string) => {
    q('[data-cw-title]').innerHTML = `<b>${esc(title)}</b><small>${sub}</small>`;
  };
  const toast = (text: string, kind: 'warn' | 'err' = 'warn') => {
    q('[data-cw-warn]').innerHTML = text ? `<div class="rfm-cw-warn"${kind === 'err' ? ' style="background:#fdecec;color:#a12b2b"' : ''}>${text}</div>` : '';
  };

  const renderBody = (keepScroll = false) => {
    if (!current) return;
    const prevH = body.scrollHeight;
    const prevTop = body.scrollTop;
    const unanswered = current.unanswered ?? current.unread ?? 0;
    const noReply = unanswered > 0 ? `<div class="rfm-cw-noreply"><button type="button" data-cw="noreply" title="Закрыть неотвеченные без ответа">Отвечать не нужно <i>${unanswered}</i></button></div>` : '';
    body.innerHTML = (hasMore ? '<div class="rfm-cw-loading" data-cw-more>Прокрутите вверх, чтобы загрузить ещё</div>' : '') + messagesHtml(messages, { isGroup: current.isGroup }) + (!messages.length ? '<div class="rfm-cw-empty">Сообщений пока нет — напишите первым</div>' : '') + noReply;
    if (keepScroll) body.scrollTop = body.scrollHeight - prevH + prevTop;
    else body.scrollTop = body.scrollHeight;
  };

  const renderChips = () => {
    q('[data-cw-chips]').innerHTML = attachments
      .map(
        (f, i) =>
          `<div class="rfm-cw-chip">${f.mime.startsWith('image/') ? `<img src="${esc(f.url)}" alt="">` : '📄'}<span>${esc(f.name)}</span><button type="button" data-cw="unchip" data-i="${i}" title="Убрать">×</button></div>`,
      )
      .join('');
    syncSendMode();
  };
  const renderReply = () => {
    q('[data-cw-reply]').innerHTML = replyTo
      ? `<div class="rfm-cw-replybar">↩ <span><b>${esc(replyTo.direction === 'out' ? (replyTo.senderName ?? 'Менеджер') : current?.title ?? 'Клиент')}:</b> ${esc(replyTo.text || `[${replyTo.kind}]`)}</span><button type="button" class="rfm-cw-ib" data-cw="unreply" title="Отменить ответ">×</button></div>`
      : '';
  };
  /** Как в Telegram: пустое поле — микрофон, есть текст или вложение — кнопка отправки. */
  const syncSendMode = () => {
    q('[data-cw-row]').classList.toggle('rfm-cw-typing', ta.value.trim() !== '' || attachments.length > 0);
  };
  const checkVariables = () => {
    const missing = unresolvedVariables(ta.value);
    toast(missing.length ? `Не заполнены переменные: ${missing.map(esc).join(', ')} — поправьте текст перед отправкой` : '');
  };

  const openChat = async (c: ChatListItem) => {
    current = c;
    replyTo = null;
    attachments = [];
    renderReply();
    renderChips();
    const sub = `${kindBadge(c.kind)} ${esc(c.contact.phone ?? (c.contact.username ? `@${c.contact.username}` : c.channelTitle))}${c.channelConnected ? '' : ' · канал не подключён'}`;
    setTitle(c.title, sub);
    overlay.innerHTML = '';
    foot.style.display = '';
    body.innerHTML = '<div class="rfm-cw-loading">Загрузка…</div>';
    try {
      const page = await chat.messages(c.id);
      messages = page.messages;
      hasMore = page.hasMore;
      renderBody();
      // Открытие чата ≠ ответ: счётчик «неотвеченных» не меняется (правило раздела «Rf Messenger»).
    } catch (err) {
      body.innerHTML = `<div class="rfm-cw-empty">${esc((err as Error).message)}</div>`;
    }
  };

  const loadMore = async () => {
    const first = messages[0];
    if (!current || !hasMore || loadingMore || !first) return;
    loadingMore = true;
    try {
      const page = await chat.messages(current.id, first.id);
      messages = [...page.messages, ...messages];
      hasMore = page.hasMore;
      renderBody(true);
    } finally {
      loadingMore = false;
    }
  };
  body.addEventListener('scroll', () => {
    if (body.scrollTop < 40) void loadMore();
  });

  const showCompose = () => {
    if (!view) return;
    foot.style.display = 'none';
    setTitle(view.contacts[0]?.name ?? 'Переписка', 'Чатов пока нет');
    const sel: { channelId?: number; contactId?: number; phone?: string; chatId?: number } = {};
    const first = view.startChannels.find((c) => c.connected);
    if (first) sel.channelId = first.id;
    const ph = view.contacts.find((c) => c.phones.length);
    if (ph) {
      sel.contactId = ph.id;
      sel.phone = ph.phones[0];
    }
    const composeView: ComposeView = { channels: view.startChannels, contacts: view.contacts };
    let text = '';
    const draw = (error?: string) => {
      body.innerHTML = `<div class="rfm-cw-compose">${renderComposer(composeView, sel, error)}</div>`;
      const t = body.querySelector<HTMLTextAreaElement>('textarea[name=text]');
      if (t) t.value = text;
    };
    draw();
    body.oninput = (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLTextAreaElement) text = t.value;
    };
    body.onchange = (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLSelectElement && t.name === 'phone') {
        const [cid, ...rest] = t.value.split('|');
        sel.contactId = Number(cid);
        sel.phone = rest.join('|');
      }
      if (t instanceof HTMLSelectElement && t.name === 'chat') sel.chatId = Number(t.value) || undefined;
    };
    body.onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rfm]');
      if (!btn) return;
      if (btn.dataset.rfm === 'cancel') return close();
      if (btn.dataset.rfm === 'pick-channel') {
        sel.channelId = Number(btn.dataset.id);
        sel.chatId = undefined;
        return draw();
      }
      if (btn.dataset.rfm === 'send') {
        if (!sel.channelId) return draw('Выберите мессенджер');
        const byChat = Boolean(view?.startChannels.find((c) => c.id === sel.channelId)?.byChat);
        if (byChat && !sel.chatId) return draw('Выберите клиента из списка');
        if (!byChat && (!sel.contactId || !sel.phone)) return draw('Нет номера клиента');
        if (!text.trim()) return draw('Введите текст первого сообщения');
        const contactId = sel.contactId ?? view?.contacts[0]?.id;
        if (!contactId) return draw('В карточке нет контакта — добавьте его');
        btn.textContent = 'Отправляем…';
        void chat.startChat({ channelId: sel.channelId, contactId, ...(byChat ? { chatId: sel.chatId } : { phone: sel.phone }), text: text.trim() }).then(
          async (r) => {
            body.onclick = null;
            body.oninput = null;
            body.onchange = null;
            await load(r.chatId);
          },
          (err: Error) => draw(err.message),
        );
      }
    };
  };

  /** Событие SSE (своё или переданное разделом): новые сообщения, счётчики, статусы. */
  const handleEvent = (ev: ChatEvent) => {
    if (closed) return;
    const item = view?.chats.find((c) => c.id === ev.chatId);
    if (ev.type === 'message' || ev.type === 'history') {
      if (current && current.id === ev.chatId) {
        void chat.messages(current.id).then((page) => {
          const known = new Set(messages.map((m) => m.id));
          const fresh = page.messages.filter((m) => !known.has(m.id));
          if (ev.type === 'history') {
            messages = page.messages;
            hasMore = page.hasMore;
            renderBody();
            toast(ev.count ? `Загружено сообщений из истории: ${ev.count}` : 'Новых сообщений в истории нет');
            return;
          }
          if (!fresh.length) return;
          const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
          messages = [...messages, ...fresh];
          renderBody(!atBottom);
        });
      }
    }
    if (ev.type === 'counters') {
      if (item) {
        item.unanswered = ev.unanswered;
        item.answered = ev.answered;
        item.unread = ev.unanswered;
      }
      if (current && current.id === ev.chatId) {
        current.unanswered = ev.unanswered;
        current.answered = ev.answered;
        current.unread = ev.unanswered;
        const bar = body.querySelector<HTMLElement>('.rfm-cw-noreply');
        if (ev.unanswered === 0) bar?.remove();
        else renderBody(true);
      }
      o.onCounters?.(ev.chatId, ev.unanswered, ev.answered);
    }
    if (ev.type === 'status') {
      const m = messages.find((x) => x.id === ev.messageId);
      if (m) {
        m.status = ev.status;
        m.error = ev.error ?? null;
        const el = body.querySelector<HTMLElement>(`.rfm-cw-msg[data-id="${m.id}"]`);
        if (el) el.outerHTML = messageHtml(m, { isGroup: current?.isGroup });
      }
    }
  };

  /** Во встроенном режиме событиями управляет раздел: он вызывает handleEvent. */
  const subscribe = async () => {
    stopEvents?.();
    stopEvents = null;
    if (!view?.chats.length || embed) return;
    stopEvents = await chat.events(view.chats.map((c) => c.id), handleEvent, w).catch(() => null);
  };

  const load = async (chatId?: number) => {
    try {
      view = await chat.chats(o.ctx);
    } catch (err) {
      body.innerHTML = `<div class="rfm-cw-empty">${esc((err as Error).message)}</div>`;
      setTitle('Переписка', 'Ошибка');
      return;
    }
    view.chats.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    const pick = (chatId && view.chats.find((c) => c.id === chatId)) || view.chats[0];
    if (!pick) return showCompose();
    body.onclick = null;
    await openChat(pick);
    await subscribe();
  };

  const showList = () => {
    if (!view) return;
    overlay.innerHTML = `<div class="rfm-cw-drawer"><div class="rfm-cw-drawer-head"><button type="button" class="rfm-cw-ib" data-cw="back">←</button>Чаты контакта · ${view.chats.length}</div><div class="rfm-cw-list">${chatListHtml(view.chats, current?.id ?? null)}</div><div style="padding:8px"><button type="button" class="rfm-cw-btn" data-cw="compose">Написать в другой мессенджер</button></div></div>`;
  };

  const showDeals = async () => {
    const cid = view?.contacts[0]?.id;
    const create = embed ? '<button type="button" data-cw="new-deal"><b>+ Создать сделку</b></button>' : '';
    if (!cid) {
      pop.innerHTML = `<div class="rfm-cw-menu" style="min-width:280px"><div class="rfm-cw-pop-head">Сделки</div><div class="rfm-cw-empty">${embed ? 'Чат ещё не привязан к контакту' : 'У карточки нет контакта'}</div>${create}</div>`;
      return;
    }
    try {
      const { leads } = await chat.contactLeads(cid);
      pop.innerHTML = `<div class="rfm-cw-menu" style="min-width:280px"><div class="rfm-cw-pop-head">Сделки контакта</div>${leads.length ? leads.map((l) => `<button type="button" data-cw="deal" data-id="${l.id}"><b>#${l.id}</b> ${esc(l.name)}${l.price ? ` · ${l.price.toLocaleString('ru-RU')} ₽` : ''}</button>`).join('') : '<div class="rfm-cw-empty">Сделок нет</div>'}${create}</div>`;
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  /** 👤+: привязать существующий контакт (поиск по имени или номеру) или создать сделку с новым контактом. */
  const showContactBox = () => {
    pop.innerHTML = `<div class="rfm-cw-menu" style="min-width:300px"><div class="rfm-cw-pop-head">Контакт amoCRM</div>
<div class="rfm-cw-contactbox"><input type="search" placeholder="Имя или номер контакта" data-cw-cq><div data-cw-cfound></div>
<button type="button" class="rfm-cw-btn" data-cw="find-contact">Найти</button><button type="button" class="rfm-cw-btn rfm-cw-btn-primary" data-cw="new-deal">Создать сделку с новым контактом</button></div></div>`;
    pop.querySelector<HTMLInputElement>('[data-cw-cq]')?.focus();
  };

  const showMenu = () => {
    pop.innerHTML = `<div class="rfm-cw-menu">
${current?.historyAvailable ? '<button type="button" data-cw="history">Загрузить историю из мессенджера</button>' : ''}
<button type="button" data-cw="my-templates">Мои шаблоны</button>
<button type="button" data-cw="close">Открыть в чате amoCRM</button>
${current?.contact.phone ? '<button type="button" data-cw="copy">Скопировать номер</button>' : ''}
</div>`;
  };

  const showTemplates = async (query: string) => {
    if (!templates) {
      templates = (await chat.templates().catch(() => ({ templates: [] }))).templates;
      tplCtx = await chat.templateContext(o.ctx).catch(() => null);
    }
    tplActive = Math.min(tplActive, Math.max(0, filterTemplates(templates, query).length - 1));
    pop.innerHTML = templatesPopoverHtml(templates, query, tplActive);
  };
  const closePop = () => {
    pop.innerHTML = '';
    tplActive = 0;
  };
  const insertTemplate = (t: TemplateView) => {
    const r = renderTemplate(t.text, tplCtx);
    ta.value = r.text;
    ta.focus();
    closePop();
    for (const a of t.attachments) attachments.push({ id: a.fileId, name: a.name, mime: a.mime, size: a.size, url: '' });
    renderChips();
    toast(r.missing.length ? `Не заполнены переменные: ${r.missing.map(esc).join(', ')} — поправьте текст перед отправкой` : '');
    void chat.usedTemplate(t.id);
  };

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files).slice(0, 10)) {
      try {
        toast(`Загрузка «${esc(f.name)}»…`);
        attachments.push(await chat.upload(f, f.name || 'file', w));
        toast('');
        renderChips();
      } catch (err) {
        toast((err as Error).message, 'err');
      }
    }
  };

  const send = async () => {
    if (!current) return;
    const text = ta.value.trim();
    if (!text && !attachments.length) return;
    const btn = q<HTMLButtonElement>('[data-cw="send"]');
    btn.disabled = true;
    try {
      const r = await chat.send(current.id, { text, replyToMessageId: replyTo?.id ?? null, fileIds: attachments.map((a) => a.id) });
      const known = new Set(messages.map((m) => m.id));
      messages = [...messages, ...r.messages.filter((m) => !known.has(m.id))];
      ta.value = '';
      ta.style.height = '';
      replyTo = null;
      attachments = [];
      renderReply();
      renderChips();
      toast('');
      if (current) {
        current.answered = (current.unanswered ?? current.unread ?? 0) || current.answered;
        current.unanswered = 0;
        current.unread = 0;
        o.onSent?.(current.id);
      }
      renderBody();
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      btn.disabled = false;
      ta.focus();
    }
  };

  const startRecording = async () => {
    const md = (w.navigator as Navigator | undefined)?.mediaDevices;
    const MR = (w as unknown as { MediaRecorder?: new (s: MediaStream, o?: { mimeType?: string }) => Recorder }).MediaRecorder;
    if (!md?.getUserMedia || !MR) return toast('Запись голосовых не поддерживается этим браузером', 'err');
    try {
      const stream = await md.getUserMedia({ audio: true });
      const isSup = (w as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder?.isTypeSupported;
      const mime = isSup?.('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : isSup?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MR(stream, mime ? { mimeType: mime } : {});
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const started = Date.now();
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder = null;
        q('[data-cw-reply]').innerHTML = '';
        renderReply();
        if (cancelRec) return;
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        const ext = type.includes('ogg') ? 'ogg' : 'webm';
        void addFiles([new File([blob], `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type })]).then(() => void send());
      };
      let cancelRec = false;
      recorder = rec;
      rec.start();
      const timer = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        const el = q<HTMLElement>('[data-cw-rec-time]');
        if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (!recorder) clearInterval(timer);
      }, 500);
      q('[data-cw-reply]').innerHTML = `<div class="rfm-cw-rec"><i></i> Запись <span data-cw-rec-time>0:00</span><button type="button" class="rfm-cw-btn" data-cw="rec-cancel">Отмена</button><button type="button" class="rfm-cw-btn rfm-cw-btn-primary" data-cw="rec-stop">Отправить</button></div>`;
      win.addEventListener(
        'click',
        (e) => {
          const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cw="rec-cancel"]');
          if (b) cancelRec = true;
        },
        { capture: true, once: true },
      );
    } catch {
      toast('Нет доступа к микрофону', 'err');
    }
  };

  // ---------- события ----------
  win.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-cw]');
    if (!btn) {
      if (!target.closest('.rfm-cw-pop') && !target.closest('.rfm-cw-menu')) closePop();
      return;
    }
    const act = btn.dataset.cw;
    const id = Number(btn.dataset.id);
    switch (act) {
      case 'close':
        return close();
      case 'list':
        return showList();
      case 'back':
        overlay.innerHTML = '';
        return;
      case 'open': {
        const c = view?.chats.find((x) => x.id === id);
        if (c) void openChat(c);
        return;
      }
      case 'compose':
        overlay.innerHTML = '';
        return showCompose();
      case 'deals':
        return void showDeals();
      case 'contact':
        return showContactBox();
      case 'find-contact': {
        const q = pop.querySelector<HTMLInputElement>('[data-cw-cq]')?.value.trim() ?? '';
        const found = pop.querySelector<HTMLElement>('[data-cw-cfound]');
        if (!found) return;
        if (q.length < 2) return void (found.innerHTML = '<div class="rfm-cw-empty">Введите хотя бы 2 символа</div>');
        void chat.searchContacts(q).then(
          (r) => void (found.innerHTML = r.contacts.length ? r.contacts.map((c) => `<button type="button" data-cw="link-contact" data-id="${c.id}"><b>${esc(c.name)}</b> <small>${esc(c.phones.join(', '))}</small></button>`).join('') : '<div class="rfm-cw-empty">Не найдено</div>'),
          (err: Error) => void (found.innerHTML = `<div class="rfm-cw-empty">${esc(err.message)}</div>`),
        );
        return;
      }
      case 'link-contact':
        if (!current) return;
        closePop();
        void chat.linkContact(current.id, id).then(() => load(current?.id), (err: Error) => toast(err.message, 'err'));
        return;
      case 'new-deal':
        if (!current) return;
        closePop();
        void chat.createLead(current.id).then(
          (r) => {
            toast(`Сделка #${r.leadId} создана`);
            w.open(`/leads/detail/${r.leadId}`, '_blank');
            void load(current?.id);
          },
          (err: Error) => toast(err.message, 'err'),
        );
        return;
      case 'noreply':
        if (!current) return;
        void chat.noReply(current.id).then(
          (r) => {
            if (current) {
              current.answered = r.answered;
              current.unanswered = 0;
              current.unread = 0;
              o.onCounters?.(current.id, 0, r.answered);
            }
            renderBody(true);
          },
          (err: Error) => toast(err.message, 'err'),
        );
        return;
      case 'deal':
        w.open(`/leads/detail/${id}`, '_blank');
        return closePop();
      case 'menu':
        return pop.innerHTML ? closePop() : showMenu();
      case 'history':
        closePop();
        if (current) void chat.history(current.id).then(() => toast('История запрошена — сообщения появятся через несколько секунд'), (err: Error) => toast(err.message, 'err'));
        return;
      case 'copy':
        closePop();
        if (current?.contact.phone) void w.navigator.clipboard?.writeText(current.contact.phone).then(() => toast('Номер скопирован'));
        return;
      case 'my-templates':
        closePop();
        w.dispatchEvent(new CustomEvent('rfm:templates', { detail: { shared: false } }));
        return;
      case 'search': {
        const box = q<HTMLElement>('[data-cw-search]');
        if (box.innerHTML) {
          box.innerHTML = '';
          return;
        }
        box.innerHTML = '<div class="rfm-cw-search"><input type="search" placeholder="Поиск по переписке…" data-cw-q><button type="button" class="rfm-cw-btn" data-cw="do-search">Найти</button></div><div class="rfm-cw-found" data-cw-found></div>';
        box.querySelector<HTMLInputElement>('[data-cw-q]')?.focus();
        return;
      }
      case 'do-search': {
        const input = q<HTMLInputElement>('[data-cw-q]');
        const found = q<HTMLElement>('[data-cw-found]');
        if (!current || input.value.trim().length < 2) return void (found.innerHTML = '<div class="rfm-cw-empty">Введите хотя бы 2 символа</div>');
        void chat.search(current.id, input.value.trim()).then(
          (r) => {
            found.innerHTML = r.messages.length ? r.messages.map((m) => `<button type="button" data-cw="jump" data-id="${m.id}"><small>${dayLabel(m.at)} ${timeLabel(m.at)} · ${m.direction === 'out' ? esc(m.senderName ?? 'Менеджер') : 'Клиент'}</small><br>${esc(m.text).slice(0, 140)}</button>`).join('') : '<div class="rfm-cw-empty">Ничего не найдено</div>';
          },
          (err: Error) => void (found.innerHTML = `<div class="rfm-cw-empty">${esc(err.message)}</div>`),
        );
        return;
      }
      case 'jump': {
        const el = body.querySelector<HTMLElement>(`.rfm-cw-msg[data-id="${id}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center' });
          el.firstElementChild?.classList.add('rfm-cw-mark');
          setTimeout(() => el.firstElementChild?.classList.remove('rfm-cw-mark'), 1500);
        } else toast('Сообщение старше загруженных — прокрутите вверх, чтобы подгрузить историю');
        return;
      }
      case 'reply':
        replyTo = messages.find((m) => m.id === id) ?? null;
        renderReply();
        ta.focus();
        return;
      case 'unreply':
        replyTo = null;
        return renderReply();
      case 'retry':
        void chat.retry(id).then(() => toast('Повторная отправка поставлена в очередь'), (err: Error) => toast(err.message, 'err'));
        return;
      case 'lightbox': {
        e.preventDefault();
        const url = btn.dataset.url ?? '';
        const light = doc.createElement('div');
        light.className = 'rfm-cw-light';
        light.innerHTML = `<img src="${esc(url)}" alt="">`;
        light.addEventListener('click', () => light.remove());
        doc.body.appendChild(light);
        return;
      }
      case 'attach':
        return fileInput.click();
      case 'unchip':
        attachments.splice(Number(btn.dataset.i), 1);
        return renderChips();
      case 'slash':
        if (pop.querySelector('.rfm-cw-pop')) return closePop();
        return void showTemplates('');
      case 'tpl': {
        const t = templates?.find((x) => x.id === id);
        if (t) insertTemplate(t);
        return;
      }
      case 'emoji':
        if (pop.querySelector('.rfm-cw-emoji')) return closePop();
        pop.innerHTML = `<div class="rfm-cw-pop"><div class="rfm-cw-emoji">${EMOJI.map((x) => `<button type="button" data-cw="emo" data-e="${x}">${x}</button>`).join('')}</div></div>`;
        return;
      case 'emo': {
        const s = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, s) + (btn.dataset.e ?? '') + ta.value.slice(ta.selectionEnd ?? s);
        syncSendMode();
        ta.focus();
        return;
      }
      case 'mic':
        if (recorder) return recorder.stop();
        return void startRecording();
      case 'rec-stop':
        return recorder?.stop();
      case 'rec-cancel':
        return recorder?.stop();
      case 'send':
        return void send();
      default:
        return;
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void addFiles(fileInput.files);
    fileInput.value = '';
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    const sq = slashQuery(ta.value);
    if (sq !== null) void showTemplates(sq);
    else if (pop.querySelector('.rfm-cw-pop-item')) closePop();
    checkVariables();
    syncSendMode();
  });
  ta.addEventListener('keydown', (e) => {
    const items = pop.querySelectorAll<HTMLElement>('[data-cw="tpl"]');
    if (items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        tplActive = (tplActive + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items.forEach((el, i) => el.classList.toggle('rfm-cw-pop-on', i === tplActive));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        items[tplActive]?.click();
        return;
      }
      if (e.key === 'Escape') return closePop();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  ta.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  });
  win.addEventListener('dragover', (e) => {
    e.preventDefault();
    win.classList.add('rfm-cw-drop');
  });
  win.addEventListener('dragleave', () => win.classList.remove('rfm-cw-drop'));
  win.addEventListener('drop', (e) => {
    e.preventDefault();
    win.classList.remove('rfm-cw-drop');
    if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (pop.innerHTML) return closePop();
    if (overlay.innerHTML) return void (overlay.innerHTML = '');
    close();
  };
  doc.addEventListener('keydown', onKey);

  function close() {
    if (closed) return;
    closed = true;
    stopEvents?.();
    recorder?.stop();
    doc.removeEventListener('keydown', onKey);
    w.removeEventListener('resize', reposition);
    w.removeEventListener('scroll', reposition, true);
    ro?.disconnect();
    win.remove();
  }

  await load(o.chatId ?? o.ctx.chatId);
  (close as typeof close & { handleEvent?: (ev: ChatEvent) => void }).handleEvent = (ev) => handleEvent(ev);
  return close;
}
