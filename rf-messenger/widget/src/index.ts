/**
 * Виджет «РФ-Мессенджер»: каналы мессенджеров, их статусы и подключение (только администратор).
 * Без фреймворков: одна страница настроек, рисуется в окне интеграции и на странице advanced_settings.
 */
declare const __API_URL__: string;

export interface AmoWidgetSelf {
  get_settings(): { widget_code: string; [key: string]: unknown };
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
  statusText: string;
  statusDetail: string | null;
  title: string;
  /** SVG QR-кода, сгенерированный нашим сервером; null — QR сейчас нет. */
  svg: string | null;
}

export interface StatusView {
  amojo: { configured: boolean; connected: boolean };
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

export class MessengerApi {
  constructor(
    private readonly self: AmoWidgetSelf,
    private readonly base: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    return this.call<{ id: number }>('POST', '/widget/v1/channels', { kind: 'telegram_bot', token });
  }
  addWhatsApp() {
    return this.call<{ id: number }>('POST', '/widget/v1/channels', { kind: 'whatsapp' });
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

/** Короткая метка статуса и её цвет. */
export function statusPill(c: Pick<ChannelView, 'kind' | 'status'>): { text: string; cls: string } {
  if (c.status === 'connected') return { text: 'Подключён', cls: 'rfm-ok-bg' };
  if (c.status === 'starting') return { text: c.kind === 'whatsapp' ? 'Ждёт QR' : 'Подключается', cls: 'rfm-warn-bg' };
  if (c.status === 'no_phone') return { text: 'Нет связи', cls: 'rfm-warn-bg' };
  if (c.status === 'session_ended') return { text: 'Сессия завершена', cls: 'rfm-err-bg' };
  return { text: 'Ошибка', cls: 'rfm-err-bg' };
}

function channelIcon(kind: string): string {
  if (kind === 'whatsapp') return `<div class="rfm-ico rfm-wa">${ICON.chat}</div>`;
  if (kind === 'telegram_bot' || kind === 'telegram_user') return `<div class="rfm-ico rfm-tg">${ICON.send}</div>`;
  return `<div class="rfm-ico rfm-off">${ICON.more}</div>`;
}

function channelCard(c: ChannelView): string {
  const pill = statusPill(c);
  const detailColor = c.status === 'error' || c.status === 'session_ended' ? '#a12b2b' : '#8a5a00';
  const detail = c.statusDetail && c.status !== 'connected' ? `<div class="rfm-detail" style="color:${detailColor}">${esc(c.statusDetail)}</div>` : '';
  const qrBtn = c.kind === 'whatsapp' && c.status !== 'connected' ? `<button type="button" class="rfm-btn" data-rfm="qr" data-id="${c.id}">Показать QR</button>` : '';
  return `<div class="rfm-card">
  ${channelIcon(c.kind)}
  <div class="rfm-main"><b>${esc(c.kindText)}</b><div class="rfm-sub">${esc(c.title)}</div>${detail}</div>
  <span class="rfm-pill ${pill.cls}">${esc(pill.text)}</span>
  ${qrBtn}
  <button type="button" class="rfm-btn rfm-icon-btn" data-rfm="delete" data-id="${c.id}" aria-label="Отключить канал" title="Отключить канал">${ICON.trash}</button>
</div>`;
}

function amojoBanner(a: StatusView['amojo']): string {
  if (!a.configured)
    return `<div class="rfm-banner rfm-warn-bg">${ICON.plug}<div><b>Канал чатов ещё не зарегистрирован в amoCRM</b><small>После регистрации техподдержкой amo здесь появится кнопка подключения.</small></div></div>`;
  if (a.connected)
    return `<div class="rfm-banner rfm-ok-bg">${ICON.plug}<div><b>amoCRM подключён</b><small>Канал чатов RFMessenger работает в этом аккаунте.</small></div></div>`;
  return `<div class="rfm-banner rfm-warn-bg">${ICON.plug}<div style="flex:1"><b>Канал чатов не подключён к аккаунту</b><small>Без этого сообщения не попадут в сделки.</small></div><button type="button" class="rfm-btn rfm-btn-primary" data-rfm="connect">Подключить к amoCRM</button></div>`;
}

/** Каналы следующих этапов — видны, но выключены. */
const PLANNED = [
  { icon: ICON.user, title: 'Telegram личный', note: 'Скоро' },
  { icon: ICON.more, title: 'MAX, VK, Авито', note: 'Скоро' },
];

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
  <button type="button" class="rfm-tile" data-rfm="show-bot"><div class="rfm-ico rfm-tg">${ICON.send}</div><b>Telegram-бот</b><small>По токену</small></button>
  ${PLANNED.map((p) => `<div class="rfm-tile rfm-tile-off"><div class="rfm-ico rfm-off">${p.icon}</div><b>${esc(p.title)}</b><small>${esc(p.note)}</small></div>`).join('')}
</div>`;
  return `<div class="rfm">
<style>${CSS}</style>
${banner}${amojoBanner(s.amojo)}
<div class="rfm-sec">Каналы · ${s.channels.length}</div>
${cards}
<div data-rfm-qr></div>
<div class="rfm-sec">Добавить канал</div>
${tiles}
<form data-rfm="add-bot" class="rfm-form" style="display:none">
  <input type="password" name="token" autocomplete="off" placeholder="123456789:AA…" required aria-label="Токен Telegram-бота">
  <button type="submit" class="rfm-btn rfm-btn-primary">Подключить бота</button>
  <div class="rfm-hint">Токен выдаёт @BotFather. После сохранения он не показывается.</div>
</form>
</div>`;
}

/** Карточка QR WhatsApp. */
export function renderQr(q: WaQrView): string {
  const steps = '<ol><li>Откройте WhatsApp на телефоне</li><li>Настройки → Связанные устройства</li><li>Привязка устройства</li><li>Наведите камеру на код</li></ol>';
  const detail = q.statusDetail ? `<div class="rfm-detail" style="color:#6b7785">${esc(q.statusDetail)}</div>` : '';
  const img = q.svg ? q.svg : `<span>${esc(q.status === 'session_ended' ? 'Код устарел' : 'Получаем код…')}</span>`;
  return `<div class="rfm-qr"><div><b style="font-weight:500">Подключение WhatsApp</b>${steps}${detail}<div class="rfm-hint" style="margin-top:6px">Код обновляется автоматически</div></div><div class="rfm-qr-img">${img}</div></div>`;
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
  const showQr = (id: number) => {
    stopPoll();
    const started = Date.now();
    const tick = async () => {
      const box = el.querySelector<HTMLElement>('[data-rfm-qr]');
      if (!box) return stopPoll();
      try {
        const q = await api.whatsappQr(id);
        if (q.status === 'connected') {
          stopPoll();
          return void draw({ info: `WhatsApp подключён: ${q.title}` });
        }
        box.innerHTML = renderQr(q);
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
    if (btn.dataset.rfm === 'show-bot') {
      const form = el.querySelector<HTMLFormElement>('form[data-rfm="add-bot"]');
      if (form) {
        form.style.display = 'flex';
        form.querySelector('input')?.focus();
      }
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
    if (btn.dataset.rfm === 'qr') {
      const id = Number(btn.dataset.id);
      void (async () => {
        try {
          await api.restartChannel(id);
          showQr(id);
        } catch (err) {
          await draw({ error: (err as Error).message });
        }
      })();
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
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-rfm="add-bot"]');
    if (!form) return;
    e.preventDefault();
    const input = form.elements.namedItem('token') as HTMLInputElement;
    const token = input.value.trim();
    input.value = '';
    void run(async () => (await api.addTelegramBot(token), 'Бот подключён'));
  });
  await draw();
}

type Callbacks = Record<string, (...args: unknown[]) => unknown>;

export function createCallbacks(self: AmoWidgetSelf, apiUrl: string = __API_URL__): Callbacks {
  const api = new MessengerApi(self, apiUrl);
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
  return {
    init: safe(() => undefined),
    bind_actions: safe(() => undefined),
    render: safe(() => undefined),
    settings: safe((...args: unknown[]) => {
      const modal = args[0] as { find?: (sel: string) => { get?: (i: number) => Element | undefined } } | undefined;
      const block = modal?.find?.('.widget_settings_block')?.get?.(0);
      if (!block) return;
      const host = document.createElement('div');
      block.appendChild(host);
      void mountSettings(host, api);
    }),
    advancedSettings: safe(() => {
      const el = document.getElementById(`work-area-${self.get_settings().widget_code}`);
      if (el) void mountSettings(el, api);
    }),
    onSave: () => true,
    destroy: safe(() => undefined),
  };
}
