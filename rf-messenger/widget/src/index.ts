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
  deleteChannel(id: number) {
    return this.call<{ deleted: boolean }>('DELETE', `/widget/v1/channels/${id}`);
  }
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

const STATUS_COLOR: Record<ChannelView['status'], string> = {
  starting: '#8a8a8a',
  connected: '#2e9e44',
  no_phone: '#d08a00',
  session_ended: '#c0392b',
  error: '#c0392b',
};

/** Каналы следующих этапов — видны, но выключены. */
const PLANNED = ['WhatsApp по QR — этап 2', 'Telegram личный — этап 3', 'MAX, VK, Авито — этап 4'];

export function renderHtml(s: StatusView, notice: { error?: string; info?: string } = {}): string {
  const amojo = !s.amojo.configured
    ? '<p class="rfm-warn">Канал чатов ещё не зарегистрирован в amoCRM. После регистрации техподдержкой amo здесь появится кнопка подключения.</p>'
    : s.amojo.connected
      ? '<p class="rfm-ok">Канал чатов подключён к аккаунту amoCRM.</p>'
      : '<p class="rfm-warn">Канал чатов не подключён к аккаунту. <button type="button" class="button-input" data-rfm="connect">Подключить к amoCRM</button></p>';
  const rows = s.channels.length
    ? s.channels
        .map(
          (c) => `<tr>
  <td>${esc(c.kindText)}</td>
  <td>${esc(c.title)}</td>
  <td><span style="color:${STATUS_COLOR[c.status]}">● ${esc(c.statusText)}</span>${c.statusDetail ? `<br><small>${esc(c.statusDetail)}</small>` : ''}</td>
  <td><button type="button" class="button-input" data-rfm="delete" data-id="${c.id}">Отключить</button></td>
</tr>`,
        )
        .join('')
    : '<tr><td colspan="4">Каналов пока нет</td></tr>';
  return `<div class="rfm">
<style>.rfm{font-size:14px;max-width:760px}.rfm table{width:100%;border-collapse:collapse;margin:8px 0}.rfm td,.rfm th{border-bottom:1px solid #e5e5e5;padding:6px;text-align:left;vertical-align:top}.rfm-ok{color:#2e9e44}.rfm-warn{color:#b26b00}.rfm-err{color:#c0392b}.rfm input[type=password]{width:360px;max-width:100%;padding:6px}.rfm small{color:#777}</style>
${notice.error ? `<p class="rfm-err">${esc(notice.error)}</p>` : ''}${notice.info ? `<p class="rfm-ok">${esc(notice.info)}</p>` : ''}
<h3>amoCRM</h3>${amojo}
<h3>Каналы</h3>
<table><thead><tr><th>Тип</th><th>Канал</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<h3>Подключить Telegram-бота</h3>
<form data-rfm="add-bot">
  <p>Токен от @BotFather. После сохранения токен не показывается.</p>
  <input type="password" name="token" autocomplete="off" placeholder="123456789:AA…" required>
  <button type="submit" class="button-input button-input_blue">Подключить</button>
</form>
<h3>Скоро</h3><ul>${PLANNED.map((p) => `<li><small>${esc(p)}</small></li>`).join('')}</ul>
</div>`;
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
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rfm]');
    if (!btn) return;
    if (btn.dataset.rfm === 'connect') {
      const id = amojoAccountId(w);
      if (!id) return void draw({ error: 'Не удалось определить amojo_id аккаунта' });
      void run(async () => (await api.connectAmojo(id), 'Канал чатов подключён'));
    }
    if (btn.dataset.rfm === 'delete') {
      const id = Number(btn.dataset.id);
      if (!w.confirm('Отключить канал? Новые сообщения из него перестанут приходить в amoCRM.')) return;
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
