/**
 * Виджет «РФ-Мессенджер»: каналы мессенджеров, их статусы и подключение (только администратор).
 * Без фреймворков: одна страница настроек, рисуется в окне интеграции и на странице advanced_settings.
 */
import { ChatApi, openChatWindow } from './chat.ts';
import { openTemplatesManager } from './templates-ui.ts';

declare const __API_URL__: string;

export interface AmoWidgetSelf {
  get_settings(): { widget_code: string; [key: string]: unknown };
  /** Где открыт виджет: lcard — карточка сделки, ccard — карточка контакта. */
  system?(): { area?: string };
  /** Блок виджета в правой панели карточки. */
  render_template?(opts: { caption: { class_name: string }; body: string; render: string }): void;
  /** amo добавляет заголовок X-Auth-Token (одноразовый JWT интеграции). */
  $authorizedAjax(opts: { url: string; method?: string; data?: string; contentType?: string; dataType?: string }): PromiseLike<unknown>;
}

export interface ChannelView {
  id: number;
  kind: string;
  kindText: string;
  title: string;
  status: 'starting' | 'connected' | 'no_phone' | 'session_ended' | 'error';
  statusText: string;
  statusDetail: string | null;
  createdAt: string;
}

export interface WaQrView {
  status: ChannelView['status'];
  /** Telegram личный: включена двухэтапная проверка, нужен пароль. */
  needPassword?: boolean;
  statusText: string;
  statusDetail: string | null;
  title: string;
  /** SVG QR-кода, сгенерированный нашим сервером; null — QR сейчас нет. */
  svg: string | null;
}

export interface StatusView {
  amojo: { configured: boolean; connected: boolean };
  /** Доступ интеграции к amoCRM (OAuth) — нужен для «Написать первым». */
  oauth?: { configured: boolean; connected: boolean; url: string };
  channels: ChannelView[];
}

declare global {
  interface Window {
    APP?: { constant?: (name: string) => unknown };
    AMOCRM?: { constant?: (name: string) => unknown };
  }
}

/** amojo_id аккаунта — нужен для подключения нашего канала чатов к аккаунту. */
export function amojoAccountId(w: Window = window): string | null {
  const account = (w.APP?.constant?.('account') ?? w.AMOCRM?.constant?.('account')) as { amojo_id?: unknown } | undefined;
  return typeof account?.amojo_id === 'string' ? account.amojo_id : null;
}

export interface ComposeView {
  channels: {
    id: number;
    kind: string;
    kindText: string;
    title: string;
    connected: boolean;
    /** VK и MAX: написать можно только тем, кто уже писал, — выбор из чатов канала. */
    byChat?: boolean;
    chats?: { id: number; title: string }[];
  }[];
  contacts: { id: number; name: string; phones: string[] }[];
  error?: string;
}

/** Данные формы подключения канала с ключами. */
export type ChannelCreate =
  | { kind: 'telegram_bot'; token: string }
  | { kind: 'max'; token: string }
  | { kind: 'vk'; token: string; groupId: string }
  | { kind: 'max_phone'; idInstance: string; apiTokenInstance: string }
  | { kind: 'avito'; clientId: string; clientSecret: string; userId: string };

export class MessengerApi {
  constructor(
    private readonly self: AmoWidgetSelf,
    private readonly base: string,
  ) {}

  /** Запрос к нашему API с токеном amoCRM (X-Auth-Token добавляет amo). */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return (await this.self.$authorizedAjax({
        url: new URL(path, this.base).toString(),
        method,
        ...(body === undefined ? {} : { data: JSON.stringify(body), contentType: 'application/json' }),
        dataType: 'json',
      })) as T;
    } catch (err) {
      const e = err as { responseJSON?: { error?: string }; status?: number };
      throw new Error(e.responseJSON?.error ?? `Сервис мессенджеров недоступен${e.status ? ` (HTTP ${e.status})` : ''}`);
    }
  }

  status() {
    return this.call<StatusView>('GET', '/widget/v1/status');
  }
  connectAmojo(amojoAccountId: string) {
    return this.call<{ connected: boolean }>('POST', '/widget/v1/amojo/connect', { amojoAccountId });
  }
  addTelegramBot(token: string) {
    return this.addChannel({ kind: 'telegram_bot', token });
  }
  addChannel(body: ChannelCreate) {
    return this.call<{ id: number; status?: string }>('POST', '/widget/v1/channels', body);
  }
  addWhatsApp() {
    return this.call<{ id: number }>('POST', '/widget/v1/channels', { kind: 'whatsapp' });
  }
  addTelegramUser() {
    return this.call<{ id: number }>('POST', '/widget/v1/channels', { kind: 'telegram_user' });
  }
  telegramPassword(id: number, password: string) {
    return this.call<{ accepted: boolean }>('POST', `/widget/v1/channels/${id}/password`, { password });
  }
  compose(q: { leadId?: number; contactId?: number }) {
    const qs = q.leadId ? `leadId=${q.leadId}` : `contactId=${q.contactId ?? 0}`;
    return this.call<ComposeView>('GET', `/widget/v1/compose?${qs}`);
  }
  startChat(body: { channelId: number; contactId: number; phone?: string; chatId?: number; text: string }) {
    return this.call<{ chatId: number; messageId: number }>('POST', '/widget/v1/chats/start', body);
  }
  whatsappQr(id: number) {
    return this.call<WaQrView>('GET', `/widget/v1/channels/${id}/qr`);
  }
  restartChannel(id: number) {
    return this.call<{ restarted: boolean }>('POST', `/widget/v1/channels/${id}/restart`);
  }
  deleteChannel(id: number) {
    return this.call<{ deleted: boolean }>('DELETE', `/widget/v1/channels/${id}`);
  }
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** Стили виджета: плоские карточки в духе amoCRM, все классы с префиксом rfm. */
const CSS = `
.rfm{font-size:14px;line-height:1.5;color:#2e3640;max-width:760px}
.rfm *{box-sizing:border-box}
.rfm-sec{font-size:12px;color:#8a96a3;margin:20px 0 8px;letter-spacing:.02em}
.rfm-banner{display:flex;align-items:center;gap:12px;border-radius:10px;padding:12px 14px;margin-bottom:4px}
.rfm-banner>svg{width:20px;height:20px;flex:none}
.rfm-banner b{display:block;font-weight:500}
.rfm-banner small{font-size:13px}
.rfm-ok-bg{background:#eaf6ec;color:#256b34}
.rfm-warn-bg{background:#fff6e5;color:#8a5a00}
.rfm-err-bg{background:#fdecec;color:#a12b2b}
.rfm-card{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:12px 14px}
.rfm-list{display:flex;flex-direction:column;gap:8px}
.rfm-ico{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;font-size:12px;font-weight:600}
.rfm-ico svg{width:20px;height:20px}
.rfm-wa{background:#e6f6ea;color:#1f8f3a}
.rfm-tg{background:#e6f1fb;color:#1e6fb8}
.rfm-off{background:#f1f3f5;color:#9aa5b1}
.rfm-max{background:#ebe7fb;color:#5b3fd1}
.rfm-vk{background:#e4eefb;color:#0a5fd6}
.rfm-av{background:#e6f4ec;color:#0f8a4b}
.rfm-form input[type=text]{flex:1}
.rfm-form select{flex:1;min-width:220px;height:34px;padding:0 10px;border:1px solid #cfd7df;border-radius:6px;font:inherit}
.rfm-main{flex:1;min-width:0}
.rfm-main b{display:block;font-weight:500}
.rfm-sub{font-size:13px;color:#6b7785;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-detail{font-size:12px;margin-top:2px}
.rfm-pill{font-size:12px;padding:3px 10px;border-radius:999px;white-space:nowrap}
.rfm-btn{font-size:13px;padding:6px 12px;border:1px solid #cfd7df;border-radius:6px;background:#fff;color:#2e3640;cursor:pointer;white-space:nowrap}
.rfm-btn:hover{background:#f5f7f9}
.rfm-btn-primary{background:#4c8bf5;border-color:#4c8bf5;color:#fff}
.rfm-btn-primary:hover{background:#3b7ae6}
.rfm-icon-btn{width:32px;height:32px;padding:0;display:flex;align-items:center;justify-content:center;color:#8a96a3}
.rfm-icon-btn svg{width:16px;height:16px}
.rfm-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
.rfm-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:14px;text-align:left;cursor:pointer;font:inherit;color:inherit}
.rfm-tile:hover{border-color:#4c8bf5}
.rfm-tile b{font-weight:500}
.rfm-tile small{font-size:12px;color:#6b7785}
.rfm-tile-off{background:#f7f8fa;cursor:default}
.rfm-tile-off:hover{border-color:#e3e8ee}
.rfm-tile-off b{color:#6b7785}
.rfm-qr{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:16px;align-items:center;background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:14px;margin-top:8px}
.rfm-qr ol{margin:6px 0 0;padding-left:18px;font-size:13px;color:#6b7785;line-height:1.8}
.rfm-qr-img{width:200px;height:200px;border-radius:8px;background:#f5f7f9;display:flex;align-items:center;justify-content:center;color:#8a96a3;font-size:13px;text-align:center;padding:8px}
.rfm-qr-img svg{width:100%;height:100%}
.rfm-form{display:flex;gap:8px;margin-top:8px;background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:12px 14px;align-items:center;flex-wrap:wrap}
.rfm-form input{flex:1;min-width:220px;height:34px;padding:0 10px;border:1px solid #cfd7df;border-radius:6px;font:inherit}
.rfm-hint{font-size:12px;color:#8a96a3;width:100%}
`;

const ICON = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="m10 13 4-4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 7h12M3 12h18M3 17h9"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
};

/** Каналы со входом по QR. */
export const QR_KINDS: ReadonlySet<string> = new Set(['whatsapp', 'telegram_user', 'max_phone']);

/** Короткая метка статуса и её цвет. */
export function statusPill(c: Pick<ChannelView, 'kind' | 'status'>): { text: string; cls: string } {
  if (c.status === 'connected') return { text: 'Подключён', cls: 'rfm-ok-bg' };
  if (c.status === 'starting') return { text: QR_KINDS.has(c.kind) ? 'Ждёт QR' : 'Подключается', cls: 'rfm-warn-bg' };
  if (c.status === 'no_phone') return { text: 'Нет связи', cls: 'rfm-warn-bg' };
  if (c.status === 'session_ended') return { text: 'Сессия завершена', cls: 'rfm-err-bg' };
  return { text: 'Ошибка', cls: 'rfm-err-bg' };
}

function channelIcon(kind: string): string {
  if (kind === 'whatsapp') return `<div class="rfm-ico rfm-wa">${ICON.chat}</div>`;
  if (kind === 'telegram_bot' || kind === 'telegram_user') return `<div class="rfm-ico rfm-tg">${ICON.send}</div>`;
  if (kind === 'max' || kind === 'max_phone') return '<div class="rfm-ico rfm-max">M</div>';
  if (kind === 'vk') return '<div class="rfm-ico rfm-vk">VK</div>';
  if (kind === 'avito') return '<div class="rfm-ico rfm-av">A</div>';
  return `<div class="rfm-ico rfm-off">${ICON.more}</div>`;
}

function channelCard(c: ChannelView): string {
  const pill = statusPill(c);
  const detailColor = c.status === 'error' || c.status === 'session_ended' ? '#a12b2b' : '#8a5a00';
  const detail = c.statusDetail && c.status !== 'connected' ? `<div class="rfm-detail" style="color:${detailColor}">${esc(c.statusDetail)}</div>` : '';
  const qrBtn = QR_KINDS.has(c.kind) && c.status !== 'connected' ? `<button type="button" class="rfm-btn" data-rfm="qr" data-id="${c.id}" data-kind="${esc(c.kind)}">Показать QR</button>` : '';
  return `<div class="rfm-card">
  ${channelIcon(c.kind)}
  <div class="rfm-main"><b>${esc(c.kindText)}</b><div class="rfm-sub">${esc(c.title)}</div>${detail}</div>
  <span class="rfm-pill ${pill.cls}">${esc(pill.text)}</span>
  ${qrBtn}
  <button type="button" class="rfm-btn rfm-icon-btn" data-rfm="delete" data-id="${c.id}" aria-label="Отключить канал" title="Отключить канал">${ICON.trash}</button>
</div>`;
}

function oauthBanner(o: StatusView['oauth']): string {
  if (!o?.configured) return '';
  if (o.connected)
    return `<div class="rfm-banner rfm-ok-bg">${ICON.user}<div><b>Доступ к amoCRM есть</b><small>Менеджеры могут написать клиенту первыми из карточки сделки.</small></div></div>`;
  return `<div class="rfm-banner rfm-warn-bg">${ICON.user}<div style="flex:1"><b>Нужна авторизация в amoCRM</b><small>Без неё не работает кнопка «Написать» в карточке сделки.</small></div><button type="button" class="rfm-btn rfm-btn-primary" data-rfm="oauth" data-url="${esc(o.url)}">Авторизовать</button></div>`;
}

function amojoBanner(a: StatusView['amojo']): string {
  if (!a.configured)
    return `<div class="rfm-banner rfm-warn-bg">${ICON.plug}<div><b>Канал чатов ещё не зарегистрирован в amoCRM</b><small>После регистрации техподдержкой amo здесь появится кнопка подключения.</small></div></div>`;
  if (a.connected)
    return `<div class="rfm-banner rfm-ok-bg">${ICON.plug}<div><b>amoCRM подключён</b><small>Канал чатов RFMessenger работает в этом аккаунте.</small></div></div>`;
  return `<div class="rfm-banner rfm-warn-bg">${ICON.plug}<div style="flex:1"><b>Канал чатов не подключён к аккаунту</b><small>Без этого сообщения не попадут в сделки.</small></div><button type="button" class="rfm-btn rfm-btn-primary" data-rfm="connect">Подключить к amoCRM</button></div>`;
}

/** Формы подключения каналов по ключам: одна форма на тип, открывается плиткой. Ключи после сохранения не показываются. */
export const KEY_FORMS: { kind: ChannelCreate['kind']; title: string; note: string; fields: { name: string; label: string; secret: boolean; placeholder?: string }[]; hint: string; done: string }[] = [
  {
    kind: 'telegram_bot',
    title: 'Telegram-бот',
    note: 'По токену',
    fields: [{ name: 'token', label: 'Токен Telegram-бота', secret: true, placeholder: '123456789:AA…' }],
    hint: 'Токен выдаёт @BotFather. После сохранения он не показывается.',
    done: 'Бот подключён',
  },
  {
    kind: 'max',
    title: 'MAX',
    note: 'Бот, по токену',
    fields: [{ name: 'token', label: 'Токен бота MAX', secret: true, placeholder: 'Токен из @MasterBot' }],
    hint: 'Токен выдаёт @MasterBot в MAX. После сохранения он не показывается.',
    done: 'Бот MAX подключён',
  },
  {
    kind: 'max_phone',
    title: 'MAX по номеру',
    note: 'Личный номер, через GREEN-API',
    fields: [
      { name: 'idInstance', label: 'idInstance', secret: false, placeholder: 'idInstance из console.green-api.com' },
      { name: 'apiTokenInstance', label: 'apiTokenInstance', secret: true, placeholder: 'apiTokenInstance' },
    ],
    hint: 'Инстанс MAX создаётся в console.green-api.com. После сохранения ключ не показывается; если инстанс ещё не вошёл в MAX — появится QR-код.',
    done: 'MAX по номеру подключён',
  },
  {
    kind: 'vk',
    title: 'VK',
    note: 'Сообщения сообщества',
    fields: [
      { name: 'groupId', label: 'id сообщества', secret: false, placeholder: 'id сообщества, например 12345678' },
      { name: 'token', label: 'Ключ доступа сообщества', secret: true, placeholder: 'Ключ доступа сообщества' },
    ],
    hint: 'Ключ: Управление сообществом → Работа с API → Ключи доступа, с правами «Сообщения», «Фотографии», «Документы», «Управление сообществом». Там же включите Long Poll API и событие «Входящее сообщение».',
    done: 'Сообщество VK подключено',
  },
  {
    kind: 'avito',
    title: 'Авито',
    note: 'Мессенджер Авито',
    fields: [
      { name: 'userId', label: 'id профиля Авито', secret: false, placeholder: 'id профиля (число)' },
      { name: 'clientId', label: 'client_id', secret: false, placeholder: 'client_id' },
      { name: 'clientSecret', label: 'client_secret', secret: true, placeholder: 'client_secret' },
    ],
    hint: 'Ключи приложения — в кабинете разработчика Авито, у приложения должен быть доступ к Messenger API. После сохранения client_secret не показывается.',
    done: 'Авито подключён',
  },
];

function keyForm(f: (typeof KEY_FORMS)[number]): string {
  const inputs = f.fields
    .map((x) => `<input type="${x.secret ? 'password' : 'text'}" name="${x.name}" autocomplete="off" placeholder="${esc(x.placeholder ?? x.label)}" required aria-label="${esc(x.label)}">`)
    .join('\n  ');
  return `<form data-rfm="add-key" data-kind="${f.kind}" class="rfm-form" style="display:none">
  ${inputs}
  <button type="submit" class="rfm-btn rfm-btn-primary">Подключить</button>
  <div class="rfm-hint">${esc(f.hint)}</div>
</form>`;
}

export function renderHtml(s: StatusView, notice: { error?: string; info?: string } = {}): string {
  const banner = notice.error
    ? `<div class="rfm-banner rfm-err-bg" style="margin-bottom:8px"><div>${esc(notice.error)}</div></div>`
    : notice.info
      ? `<div class="rfm-banner rfm-ok-bg" style="margin-bottom:8px"><div>${esc(notice.info)}</div></div>`
      : '';
  const cards = s.channels.length
    ? `<div class="rfm-list">${s.channels.map(channelCard).join('')}</div>`
    : '<div class="rfm-card"><div class="rfm-main"><div class="rfm-sub">Каналов пока нет — добавьте первый ниже</div></div></div>';
  const tiles = `<div class="rfm-tiles">
  <button type="button" class="rfm-tile" data-rfm="add-wa"><div class="rfm-ico rfm-wa">${ICON.chat}</div><b>WhatsApp</b><small>По QR-коду</small></button>
  <button type="button" class="rfm-tile" data-rfm="add-tg"><div class="rfm-ico rfm-tg">${ICON.user}</div><b>Telegram личный</b><small>По QR-коду</small></button>
  ${KEY_FORMS.map((f) => `<button type="button" class="rfm-tile" data-rfm="show-form" data-kind="${f.kind}">${channelIcon(f.kind)}<b>${esc(f.title)}</b><small>${esc(f.note)}</small></button>`).join('\n  ')}
</div>`;
  return `<div class="rfm">
<style>${CSS}</style>
${banner}${amojoBanner(s.amojo)}${oauthBanner(s.oauth)}
<div class="rfm-sec">Шаблоны сообщений</div>
<div class="rfm-card"><div class="rfm-main"><b>Общие шаблоны</b><div class="rfm-sub">Доступны всем менеджерам в окне переписки по «/». Личные шаблоны каждый ведёт сам: ⋮ → «Мои шаблоны».</div></div><button type="button" class="rfm-btn" data-rfm="templates">Открыть</button></div>
<div class="rfm-sec">Каналы · ${s.channels.length}</div>
${cards}
<div data-rfm-qr></div>
<div class="rfm-sec">Добавить канал</div>
${tiles}
${KEY_FORMS.map(keyForm).join('\n')}
</div>`;
}

/** Карточка QR WhatsApp. */
export function renderQr(q: WaQrView, kind = 'whatsapp'): string {
  const tg = kind === 'telegram_user';
  if (tg && q.needPassword)
    return `<form class="rfm-form" data-rfm="tg-password"><b style="font-weight:500;width:100%">Пароль двухэтапной проверки Telegram</b><input type="password" name="password" autocomplete="off" required aria-label="Пароль Telegram"><button type="submit" class="rfm-btn rfm-btn-primary">Войти</button><div class="rfm-hint">${esc(q.statusDetail ?? '')}</div></form>`;
  const mx = kind === 'max_phone';
  const steps = tg
    ? '<ol><li>Откройте Telegram на телефоне</li><li>Настройки → Устройства</li><li>Подключить устройство</li><li>Наведите камеру на код</li></ol>'
    : mx
      ? '<ol><li>Откройте MAX на телефоне</li><li>Настройки → Устройства → Подключить устройство</li><li>Пароль для входа в MAX должен быть отключён</li><li>Наведите камеру на код</li></ol>'
      : '<ol><li>Откройте WhatsApp на телефоне</li><li>Настройки → Связанные устройства</li><li>Привязка устройства</li><li>Наведите камеру на код</li></ol>';
  const detail = q.statusDetail ? `<div class="rfm-detail" style="color:#6b7785">${esc(q.statusDetail)}</div>` : '';
  const img = q.svg ? q.svg : `<span>${esc(q.status === 'session_ended' ? 'Код устарел' : 'Получаем код…')}</span>`;
  return `<div class="rfm-qr"><div><b style="font-weight:500">Подключение ${tg ? 'Telegram' : mx ? 'MAX' : 'WhatsApp'}</b>${steps}${detail}<div class="rfm-hint" style="margin-top:6px">Код обновляется автоматически</div></div><div class="rfm-qr-img">${img}</div></div>`;
}

/** Страница настроек: загрузка статуса и обработка кнопок. */
export async function mountSettings(el: HTMLElement, api: MessengerApi, w: Window = window): Promise<void> {
  const draw = async (notice: { error?: string; info?: string } = {}) => {
    try {
      el.innerHTML = renderHtml(await api.status(), notice);
    } catch (err) {
      el.innerHTML = `<div class="rfm"><p style="color:#c0392b">${esc((err as Error).message)}</p></div>`;
    }
  };
  const run = async (fn: () => Promise<string>) => {
    try {
      await draw({ info: await fn() });
    } catch (err) {
      await draw({ error: (err as Error).message });
    }
  };
  let poll: ReturnType<typeof setInterval> | null = null;
  const stopPoll = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };
  /** Показ QR WhatsApp: опрос раз в 3 с, до входа или 3 минут. */
  const showQr = (id: number, kind = 'whatsapp') => {
    stopPoll();
    const started = Date.now();
    const tick = async () => {
      const box = el.querySelector<HTMLElement>('[data-rfm-qr]');
      if (!box) return stopPoll();
      try {
        const q = await api.whatsappQr(id);
        if (q.status === 'connected') {
          stopPoll();
          return void draw({ info: `${kind === 'telegram_user' ? 'Telegram' : kind === 'max_phone' ? 'MAX' : 'WhatsApp'} подключён: ${q.title}` });
        }
        // Поле пароля не перерисовываем, пока менеджер его вводит.
        if (q.needPassword && (box.querySelector('form[data-rfm="tg-password"]') || Date.now() - Number(box.dataset.pwSent ?? 0) < 20_000)) return;
        box.innerHTML = renderQr(q, kind);
        box.dataset.id = String(id);
      } catch (err) {
        box.innerHTML = `<div class="rfm-banner rfm-err-bg" style="margin-top:8px"><div>${esc((err as Error).message)}</div></div>`;
      }
      if (Date.now() - started > 180_000) {
        stopPoll();
        box.innerHTML = '<div class="rfm-banner rfm-warn-bg" style="margin-top:8px"><div>Время на сканирование вышло. Нажмите «Показать QR» ещё раз.</div></div>';
      }
    };
    void tick();
    poll = setInterval(() => void tick(), 3000);
  };
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rfm]');
    if (!btn) return;
    if (btn.dataset.rfm === 'show-form') {
      el.querySelectorAll<HTMLFormElement>('form[data-rfm="add-key"]').forEach((f) => (f.style.display = f.dataset.kind === btn.dataset.kind ? 'flex' : 'none'));
      el.querySelector<HTMLInputElement>(`form[data-kind="${btn.dataset.kind}"] input`)?.focus();
    }
    if (btn.dataset.rfm === 'add-wa') {
      stopPoll();
      void (async () => {
        try {
          const { id } = await api.addWhatsApp();
          await draw();
          showQr(id);
        } catch (err) {
          await draw({ error: (err as Error).message });
        }
      })();
    }
    if (btn.dataset.rfm === 'add-tg') {
      stopPoll();
      void (async () => {
        try {
          const { id } = await api.addTelegramUser();
          await draw();
          showQr(id, 'telegram_user');
        } catch (err) {
          await draw({ error: (err as Error).message });
        }
      })();
    }
    if (btn.dataset.rfm === 'oauth') {
      const url = btn.dataset.url;
      if (!url) return;
      const popup = w.open(url, 'rfm_oauth', 'width=760,height=640');
      // После закрытия окна авторизации — обновить статус.
      const timer = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(timer);
          void draw();
        }
      }, 1000);
    }
    if (btn.dataset.rfm === 'qr') {
      const id = Number(btn.dataset.id);
      const kind = btn.dataset.kind ?? 'whatsapp';
      void (async () => {
        try {
          await api.restartChannel(id);
          showQr(id, kind);
        } catch (err) {
          await draw({ error: (err as Error).message });
        }
      })();
    }
    if (btn.dataset.rfm === 'templates') {
      w.dispatchEvent(new CustomEvent('rfm:templates', { detail: { shared: true } }));
      return;
    }
    if (btn.dataset.rfm === 'connect') {
      const id = amojoAccountId(w);
      if (!id) return void draw({ error: 'Не удалось определить amojo_id аккаунта' });
      void run(async () => (await api.connectAmojo(id), 'Канал чатов подключён'));
    }
    if (btn.dataset.rfm === 'delete') {
      const id = Number(btn.dataset.id);
      if (!w.confirm('Отключить канал? Новые сообщения из него перестанут приходить в amoCRM.')) return;
      stopPoll();
      void run(async () => (await api.deleteChannel(id), 'Канал отключён'));
    }
  });
  el.addEventListener('submit', (e) => {
    const pwForm = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-rfm="tg-password"]');
    if (pwForm) {
      e.preventDefault();
      const input = pwForm.elements.namedItem('password') as HTMLInputElement;
      const password = input.value;
      input.value = '';
      const id = Number(el.querySelector<HTMLElement>('[data-rfm-qr]')?.dataset.id);
      void api.telegramPassword(id, password).then(
        () => {
          const box = el.querySelector<HTMLElement>('[data-rfm-qr]');
          if (box) {
            box.dataset.pwSent = String(Date.now());
            box.innerHTML = '<div class="rfm-banner rfm-ok-bg" style="margin-top:8px"><div>Пароль отправлен, входим…</div></div>';
          }
        },
        (err: Error) => void draw({ error: err.message }),
      );
      return;
    }
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-rfm="add-key"]');
    if (!form) return;
    e.preventDefault();
    const def = KEY_FORMS.find((f) => f.kind === form.dataset.kind);
    if (!def) return;
    const body: Record<string, string> = { kind: def.kind };
    for (const f of def.fields) {
      const input = form.elements.namedItem(f.name) as HTMLInputElement;
      body[f.name] = input.value.trim();
      // Ключи не остаются в поле после отправки.
      if (f.secret) input.value = '';
    }
    if (def.kind === 'max_phone') {
      stopPoll();
      void (async () => {
        try {
          const { id, status } = await api.addChannel(body as unknown as ChannelCreate);
          await draw(status === 'connected' ? { info: def.done } : {});
          if (status !== 'connected') showQr(id, 'max_phone');
        } catch (err) {
          await draw({ error: (err as Error).message });
        }
      })();
      return;
    }
    void run(async () => (await api.addChannel(body as unknown as ChannelCreate), def.done));
  });
  await draw();
}

// ---------- Карточка сделки и контакта: «Написать первым» ----------

const CARD_CSS = `
.rfm-caption{background:#fff!important;padding:9px 34px 9px 12px!important;position:relative;display:flex!important;align-items:center;gap:8px;margin:0!important;width:100%!important;box-sizing:border-box!important;border-bottom:1px solid #e1e5e9;min-height:0!important;height:auto!important;line-height:0;text-align:left}
.rfm-caption img.card-widgets__widget__caption__logo{height:20px!important;width:auto!important;max-width:150px!important;margin:0!important;object-fit:contain}
.rfm-caption img.card-widgets__widget__caption__logo_min{display:none!important}
.rfm-caption::after{content:'Rf Messenger';font:600 13px/1.2 'Open Sans','PT Sans',Arial,sans-serif;color:#28313d;white-space:nowrap}
.rfm-caption .card-widgets__widget__caption__arrow{position:absolute!important;right:12px;top:50%;margin:0!important;transform:translateY(-50%);width:12px!important;height:12px!important;background:none!important}
.rfm-caption .card-widgets__widget__caption__arrow::after{content:'';display:block;width:7px;height:7px;margin:0 0 0 1px;border-right:2px solid #8a949f;border-bottom:2px solid #8a949f;transform:rotate(45deg) translate(-2px,-2px)}
.rfm-caption .widgets__widget__caption__arrow_top::after{transform:rotate(-135deg) translate(-2px,-2px)}
.rfm-card-panel{padding:10px 12px;width:100%;box-sizing:border-box;background:#fff}
.rfm-first{width:100%;display:flex;align-items:center;justify-content:center;gap:6px;height:34px;border:1px solid #4c8bf5;border-radius:6px;background:#fff;color:#2f6fd6;font:inherit;font-size:13px;cursor:pointer}
.rfm-first:hover{background:#f2f7ff}
.rfm-first-primary{background:#25c25a;border-color:#25c25a;color:#fff}
.rfm-first-primary:hover{background:#1fa94d}
.rfm-first svg{width:16px;height:16px}
.rfm-overlay{position:fixed;inset:0;background:rgba(32,42,54,.45);z-index:10000;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1.5;color:#2e3640}
.rfm-modal{background:#fff;border-radius:10px;width:min(520px,calc(100vw - 32px));padding:18px 20px;display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 32px);overflow:auto}
.rfm-modal *{box-sizing:border-box}
.rfm-modal h3{margin:0;font-size:16px;font-weight:500}
.rfm-lbl{font-size:12px;color:#6b7785;margin-bottom:4px}
.rfm-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}
.rfm-opt{display:flex;align-items:center;gap:8px;border:1px solid #cfd7df;border-radius:8px;padding:8px 10px;cursor:pointer;font:inherit;font-size:13px;background:#fff;text-align:left;color:inherit}
.rfm-opt[aria-pressed=true]{border:2px solid #4c8bf5;padding:7px 9px}
.rfm-opt[disabled]{opacity:.55;cursor:default}
.rfm-opt .rfm-ico{width:28px;height:28px}
.rfm-opt .rfm-ico svg{width:16px;height:16px}
.rfm-modal select,.rfm-modal textarea{width:100%;border:1px solid #cfd7df;border-radius:6px;font:inherit;padding:7px 10px}
.rfm-modal textarea{min-height:90px;resize:vertical}
.rfm-actions{display:flex;justify-content:flex-end;gap:8px}
.rfm-err{background:#fdecec;color:#a12b2b;border-radius:8px;padding:8px 10px;font-size:13px}
.rfm-note{font-size:12px;color:#8a96a3}
`;

/** Где открыт виджет и id карточки (сделка или контакт). null — не карточка. */
export function cardContext(self: AmoWidgetSelf, w: Window = window): { leadId?: number; contactId?: number } | null {
  const area = self.system?.().area ?? '';
  const data = (w as unknown as { AMOCRM?: { data?: { current_card?: { id?: unknown } } }; APP?: { data?: { current_card?: { id?: unknown } } } });
  const id = Number(data.APP?.data?.current_card?.id ?? data.AMOCRM?.data?.current_card?.id ?? 0);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (area === 'lcard') return { leadId: id };
  if (area === 'ccard') return { contactId: id };
  return null;
}

export function renderCardPanel(): string {
  return `<div class="rfm-card-panel"><style>${CARD_CSS}</style><button type="button" class="rfm-first rfm-first-primary" data-rfm="chat">${ICON.chat}Открыть переписку</button><button type="button" class="rfm-first" style="margin-top:6px" data-rfm="first">${ICON.send}Написать</button></div>`;
}

/**
 * Окно «Написать». WhatsApp и Telegram личный — по номеру из контакта;
 * VK и MAX — только тем, кто уже писал сообществу или боту (выбор из чатов канала); Авито — нет.
 */
export function renderComposer(v: ComposeView, sel: { channelId?: number; contactId?: number; phone?: string; chatId?: number }, error?: string): string {
  const channels = v.channels
    .map((c) => {
      const icon = c.kind === 'whatsapp' ? `<div class="rfm-ico rfm-wa">${ICON.chat}</div>` : c.kind === 'telegram_user' ? `<div class="rfm-ico rfm-tg">${ICON.user}</div>` : channelIcon(c.kind);
      const sub = c.connected ? esc(c.title) : 'Не подключён';
      return `<button type="button" class="rfm-opt" data-rfm="pick-channel" data-id="${c.id}" aria-pressed="${c.id === sel.channelId}"${c.connected ? '' : ' disabled'}>${icon}<span><b style="font-weight:500">${esc(c.kindText)}</b><br><small>${sub}</small></span></button>`;
    })
    .join('');
  const current = v.channels.find((c) => c.id === sel.channelId);
  const phones = v.contacts.flatMap((c) => c.phones.map((p) => ({ contactId: c.id, name: c.name, phone: p })));
  const phoneOpts = phones
    .map((p) => `<option value="${p.contactId}|${esc(p.phone)}"${p.contactId === sel.contactId && p.phone === sel.phone ? ' selected' : ''}>${esc(p.phone)} — ${esc(p.name)}</option>`)
    .join('');
  const chats = current?.chats ?? [];
  const chatOpts = chats.map((c) => `<option value="${c.id}"${c.id === sel.chatId ? ' selected' : ''}>${esc(c.title)}</option>`).join('');
  const target = current?.byChat
    ? `<div><div class="rfm-lbl">Клиент — из тех, кто уже писал в ${esc(current.kindText)}</div>${chats.length ? `<select name="chat"><option value="">— выберите чат —</option>${chatOpts}</select>` : `<div class="rfm-note">В ${esc(current.kindText)} ещё никто не писал. Написать первым здесь нельзя — клиент должен сам начать диалог.</div>`}</div>`
    : `<div><div class="rfm-lbl">Номер клиента — из контакта</div>${phones.length ? `<select name="phone">${phoneOpts}</select>` : '<div class="rfm-note">У контакта нет телефона — добавьте его в карточку.</div>'}</div>`;
  const err = error ?? v.error;
  return `<div class="rfm-modal" role="dialog" aria-modal="true" aria-label="Написать">
<h3>Написать</h3>
${err ? `<div class="rfm-err">${esc(err)}</div>` : ''}
<div><div class="rfm-lbl">Мессенджер</div>${channels ? `<div class="rfm-opts">${channels}</div>` : '<div class="rfm-note">Нет каналов для отправки — администратору нужно подключить WhatsApp, Telegram личный, VK или MAX в настройках виджета.</div>'}</div>
${target}
<div><div class="rfm-lbl">Первое сообщение</div><textarea name="text" maxlength="4000" placeholder="Добрый день! Это РФ-Двери…"></textarea></div>
<div class="rfm-actions"><button type="button" class="rfm-btn" data-rfm="cancel">Отмена</button><button type="button" class="rfm-btn rfm-btn-primary" data-rfm="send">Отправить</button></div>
<div class="rfm-note">Дальше переписка идёт в чате сделки amoCRM.</div>
</div>`;
}

/** Открывает окно поверх amoCRM и отправляет первое сообщение. */
export async function openComposer(api: MessengerApi, ctx: { leadId?: number; contactId?: number }, doc: Document = document): Promise<void> {
  const overlay = doc.createElement('div');
  overlay.className = 'rfm-overlay';
  overlay.innerHTML = `<style>${CSS}${CARD_CSS}</style><div class="rfm-modal"><div class="rfm-note">Загрузка…</div></div>`;
  doc.body.appendChild(overlay);
  const close = () => overlay.remove();
  let view: ComposeView;
  try {
    view = await api.compose(ctx);
  } catch (err) {
    view = { channels: [], contacts: [], error: (err as Error).message };
  }
  const firstPhone = view.contacts.find((c) => c.phones.length);
  const firstChannel = view.channels.find((c) => c.connected);
  const sel: { channelId?: number; contactId?: number; phone?: string; chatId?: number } = {
    ...(firstChannel ? { channelId: firstChannel.id } : {}),
    ...(firstPhone ? { contactId: firstPhone.id, phone: firstPhone.phones[0] } : {}),
  };
  let text = '';
  let busy = false;
  const draw = (error?: string) => {
    overlay.innerHTML = `<style>${CSS}${CARD_CSS}</style>${renderComposer(view, sel, error)}`;
    const ta = overlay.querySelector<HTMLTextAreaElement>('textarea[name=text]');
    if (ta) ta.value = text;
  };
  draw();
  overlay.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement) text = t.value;
  });
  overlay.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLSelectElement && t.name === 'phone') {
      const [cid, ...rest] = t.value.split('|');
      sel.contactId = Number(cid);
      sel.phone = rest.join('|');
    }
    if (t instanceof HTMLSelectElement && t.name === 'chat') sel.chatId = Number(t.value) || undefined;
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) return close();
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rfm]');
    if (!btn) return;
    if (btn.dataset.rfm === 'cancel') return close();
    if (btn.dataset.rfm === 'pick-channel') {
      sel.channelId = Number(btn.dataset.id);
      sel.chatId = undefined;
      return draw();
    }
    if (btn.dataset.rfm === 'send' && !busy) {
      if (!sel.channelId) return draw('Выберите мессенджер');
      const byChat = Boolean(view.channels.find((c) => c.id === sel.channelId)?.byChat);
      if (byChat && !sel.chatId) return draw('Выберите клиента из списка');
      if (!byChat && (!sel.contactId || !sel.phone)) return draw('Нет номера клиента');
      if (!text.trim()) return draw('Введите текст первого сообщения');
      // Контакт карточки нужен и для чатов VK/MAX: чат amo привязывается к нему.
      const contactId = sel.contactId ?? view.contacts[0]?.id;
      if (!contactId) return draw('В карточке нет контакта — добавьте его');
      busy = true;
      btn.textContent = 'Отправляем…';
      void api.startChat({ channelId: sel.channelId, contactId, ...(byChat ? { chatId: sel.chatId } : { phone: sel.phone }), text: text.trim() }).then(
        () => {
          overlay.innerHTML = `<style>${CSS}${CARD_CSS}</style><div class="rfm-modal"><h3>Сообщение отправлено</h3><div>Переписка появится в чате сделки. Если её не видно — обновите страницу.</div><div class="rfm-actions"><button type="button" class="rfm-btn rfm-btn-primary" data-rfm="cancel">Готово</button></div></div>`;
        },
        (err: Error) => {
          busy = false;
          draw(err.message);
        },
      );
    }
  });
}

type Callbacks = Record<string, (...args: unknown[]) => unknown>;

export function createCallbacks(self: AmoWidgetSelf, apiUrl: string = __API_URL__): Callbacks {
  const api = new MessengerApi(self, apiUrl);
  const chat = new ChatApi(api, apiUrl);
  const safe =
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      try {
        fn(...args);
      } catch (err) {
        // eslint-disable-next-line no-console -- единственный канал диагностики внутри amo
        console.error('[rf-messenger] widget error', err);
      }
      return true;
    };
  // Окно шаблонов открывается по событию из настроек (общие) и из окна переписки (личные).
  const bindTemplates = () => {
    const flag = document.body as HTMLElement & { __rfmTpl?: boolean };
    if (flag.__rfmTpl) return;
    flag.__rfmTpl = true;
    window.addEventListener('rfm:templates', (e) => {
      const shared = Boolean((e as CustomEvent<{ shared?: boolean }>).detail?.shared);
      void openTemplatesManager(chat, { shared, isAdmin: shared });
    });
  };
  return {
    init: safe(() => undefined),
    bind_actions: safe(() => undefined),
    render: safe(() => {
      const ctx = cardContext(self);
      if (!ctx || !self.render_template) return;
      self.render_template({ caption: { class_name: 'rfm-caption' }, body: '', render: renderCardPanel() });
      // Блок виджета вставляется amo; кнопку ловим делегированием (render может вызываться повторно).
      if (!(document.body as HTMLElement & { __rfmFirst?: boolean }).__rfmFirst) {
        (document.body as HTMLElement & { __rfmFirst?: boolean }).__rfmFirst = true;
        document.body.addEventListener('click', (e) => {
          const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rfm="first"],[data-rfm="chat"]');
          if (!btn) return;
          const c = cardContext(self);
          if (!c) return;
          if (btn.dataset.rfm === 'chat') void openChatWindow(chat, { ctx: c });
          else void openComposer(api, c);
        });
        bindTemplates();
      }
    }),
    settings: safe((...args: unknown[]) => {
      const modal = args[0] as { find?: (sel: string) => { get?: (i: number) => Element | undefined } } | undefined;
      const block = modal?.find?.('.widget_settings_block')?.get?.(0);
      if (!block) return;
      const host = document.createElement('div');
      block.appendChild(host);
      bindTemplates();
      void mountSettings(host, api);
    }),
    advancedSettings: safe(() => {
      const el = document.getElementById(`work-area-${self.get_settings().widget_code}`);
      bindTemplates();
      if (el) void mountSettings(el, api);
    }),
    onSave: () => true,
    destroy: safe(() => undefined),
  };
}
