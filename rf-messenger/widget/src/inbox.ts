/**
 * Раздел «Rf Messenger» в левом меню amoCRM (как у Wazzup): слева — все чаты всех менеджеров с фильтрами,
 * поиском и счётчиками неотвеченных, справа — открытый диалог (встроенное окно переписки из карточки).
 * Правило счётчиков: входящее — красный, открытие ничего не меняет, ответ или «Отвечать не нужно» — серый.
 */
import { dayLabel, esc, kindBadge, openChatWindow, timeLabel, type ChatApi, type ChatEvent, type ChatListItem } from './chat.ts';

export type InboxFilter = 'all' | 'unanswered' | 'mine';

export interface InboxChannel {
  id: number;
  kind: string;
  kindText: string;
  title: string;
  connected: boolean;
}

const FILE_ICON: Record<string, string> = { picture: '🖼', video: '🎬', voice: '🎤', audio: '🎵', file: '📄', sticker: '🙂' };

/** Начало последнего сообщения: для файла — значок и имя файла. */
export function lastPreview(c: ChatListItem): string {
  const l = c.last;
  if (!l) return '';
  const who = l.direction === 'out' ? 'Вы: ' : '';
  if (l.kind !== 'text') return `${who}${FILE_ICON[l.kind] ?? '📎'} ${l.fileName ?? l.text ?? ''}`.trim();
  return who + l.text;
}

/** Время в строке чата: сегодня — HH:MM, вчера — «Вчера», иначе дата. */
export function rowTime(iso: string, now: Date = new Date()): string {
  const d = dayLabel(iso, now);
  return d === 'Сегодня' ? timeLabel(iso) : d;
}

/** Инициалы для аватара. */
export const initials = (title: string) =>
  title
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

export function chatRowHtml(c: ChatListItem, currentId: number | null, now: Date = new Date()): string {
  const red = c.unanswered ?? c.unread ?? 0;
  const grey = c.answered ?? 0;
  const counter = red ? `<i class="rfm-ib-cnt rfm-ib-red">${red}</i>` : grey ? `<i class="rfm-ib-cnt rfm-ib-grey">${grey}</i>` : '';
  const sub = c.contact.phone ?? (c.contact.username ? `@${c.contact.username}` : c.channelTitle);
  return `<div class="rfm-ib-row${c.id === currentId ? ' rfm-ib-row-on' : ''}${c.pinned ? ' rfm-ib-pinned' : ''}" data-ib="open" data-id="${c.id}">
<div class="rfm-ib-ava">${c.isGroup ? '👥' : esc(initials(c.title))}${kindBadge(c.kind)}</div>
<div class="rfm-ib-main"><div class="rfm-ib-top"><b>${c.isGroup ? '<span class="rfm-ib-grp" title="Групповой чат">👥</span> ' : ''}${esc(c.title)}</b><small>${esc(rowTime(c.lastAt, now))}</small></div>
<div class="rfm-ib-bot"><span class="rfm-ib-last">${esc(lastPreview(c) || sub)}</span>${counter}<button type="button" class="rfm-ib-more" data-ib="row-menu" data-id="${c.id}" title="Ещё">⌄</button></div></div>
</div>`;
}

export function inboxHeaderTitle(channels: readonly InboxChannel[], channelId: number | null): string {
  if (channelId) {
    const c = channels.find((x) => x.id === channelId);
    return c ? `${c.kindText} ${c.title.replace(new RegExp(`^${c.kindText}\\s*`), '')}`.trim() : 'Канал';
  }
  if (channels.length === 1 && channels[0]) return `${channels[0].kindText} ${channels[0].title.replace(new RegExp(`^${channels[0].kindText}\\s*`), '')}`.trim();
  return `Все каналы · ${channels.length}`;
}

export const INBOX_CSS = `
.rfm-ib{display:flex;height:100%;min-height:480px;background:#fff;font:13px/1.45 'Open Sans','PT Sans',Arial,sans-serif;color:#2e3640}
.rfm-ib *{box-sizing:border-box}
.rfm-ib button{font:inherit;color:inherit;cursor:pointer}
.rfm-ib-left{width:380px;flex:none;border-right:1px solid #e1e5e9;display:flex;flex-direction:column;min-width:0}
.rfm-ib-right{flex:1;min-width:0;position:relative;background:#eef1f5}
.rfm-ib-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e1e5e9}
.rfm-ib-head b{flex:1;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-ib-ib{width:30px;height:30px;border:0;background:transparent;border-radius:6px;font-size:16px;color:#5f6b78;display:flex;align-items:center;justify-content:center}
.rfm-ib-ib:hover{background:#eef2f6}
.rfm-ib-search{padding:8px 12px;border-bottom:1px solid #e1e5e9}
.rfm-ib-search input{width:100%;height:32px;border:1px solid #cfd7df;border-radius:8px;padding:0 10px 0 30px;font:inherit;background:#f5f7f9 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238a96a3' stroke-width='2'><circle cx='11' cy='11' r='7'/><path d='m20 20-3.5-3.5'/></svg>") 9px center no-repeat}
.rfm-ib-filters{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #e1e5e9}
.rfm-ib-filters button{border:1px solid #cfd7df;background:#fff;border-radius:999px;padding:3px 12px;font-size:12px}
.rfm-ib-filters button[aria-pressed=true]{background:#2e3640;color:#fff;border-color:#2e3640}
.rfm-ib-list{flex:1;overflow:auto}
.rfm-ib-row{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid #f0f2f4;cursor:pointer;position:relative}
.rfm-ib-row:hover,.rfm-ib-row-on{background:#f2f7ff}
.rfm-ib-pinned{background:#fffaf0}
.rfm-ib-ava{position:relative;width:42px;height:42px;border-radius:50%;background:#dfe5ec;color:#55606c;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;flex:none}
.rfm-ib-ava .rfm-cw-badge{position:absolute;right:-3px;bottom:-3px;width:18px;height:18px;font-size:9px;border:2px solid #fff}
.rfm-cw-badge{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:700}
.rfm-wa{background:#e6f6ea;color:#1f8f3a}.rfm-tg{background:#e6f1fb;color:#1e6fb8}.rfm-max{background:#ebe7fb;color:#5b3fd1}.rfm-vk{background:#e4eefb;color:#0a5fd6}.rfm-av{background:#e6f4ec;color:#0f8a4b}.rfm-off{background:#f1f3f5;color:#9aa5b1}
.rfm-ib-main{flex:1;min-width:0}
.rfm-ib-top{display:flex;justify-content:space-between;gap:8px}
.rfm-ib-top b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-ib-top small{color:#8a96a3;font-size:11px;flex:none}
.rfm-ib-bot{display:flex;align-items:center;gap:6px;margin-top:2px}
.rfm-ib-last{flex:1;color:#6b7785;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rfm-ib-cnt{font-style:normal;border-radius:999px;padding:1px 7px;font-size:11px;font-weight:600;flex:none}
.rfm-ib-red{background:#e5484d;color:#fff}
.rfm-ib-grey{background:#c9d1d9;color:#fff}
.rfm-ib-more{border:0;background:transparent;color:#8a96a3;padding:0 4px;opacity:0;font-size:14px}
.rfm-ib-row:hover .rfm-ib-more{opacity:1}
.rfm-ib-empty{padding:24px;text-align:center;color:#8a96a3}
.rfm-ib-menu{position:absolute;background:#fff;border:1px solid #cfd7df;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);z-index:5;min-width:220px;padding:4px}
.rfm-ib-menu button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:8px 12px;border-radius:6px}
.rfm-ib-menu button:hover{background:#eef2f6}
.rfm-ib-menu button[aria-pressed=true]{font-weight:600}
.rfm-ib-placeholder{height:100%;display:flex;align-items:center;justify-content:center;color:#8a96a3;flex-direction:column;gap:6px}
.rfm-ib-more-btn{margin:8px;border:1px solid #cfd7df;background:#fff;border-radius:6px;padding:6px 12px;width:calc(100% - 16px)}
`;

export function inboxFrameHtml(): string {
  return `<style>${INBOX_CSS}</style><div class="rfm-ib">
<div class="rfm-ib-left">
  <div class="rfm-ib-head"><b data-ib-title>Rf Messenger</b><button type="button" class="rfm-ib-ib" data-ib="channels" title="Канал">⋮</button></div>
  <div class="rfm-ib-search"><input type="search" placeholder="Поиск по имени, номеру, нику, сообщениям" data-ib-q></div>
  <div class="rfm-ib-filters"><button type="button" data-ib="filter" data-f="all" aria-pressed="true">Все</button><button type="button" data-ib="filter" data-f="unanswered" aria-pressed="false">Неотвеченные</button><button type="button" data-ib="filter" data-f="mine" aria-pressed="false">Мои</button></div>
  <div class="rfm-ib-list" data-ib-list><div class="rfm-ib-empty">Загрузка…</div></div>
</div>
<div class="rfm-ib-right" data-ib-right><div class="rfm-ib-placeholder"><div style="font-size:32px">💬</div><div>Выберите чат слева</div></div></div>
<div data-ib-pop></div>
</div>`;
}

export interface InboxOptions {
  doc?: Document;
  win?: Window;
  /** Обновление общего счётчика в левом меню. */
  onBadge?: (unansweredChats: number) => void;
}

/** Монтирует раздел в элемент. Возвращает функцию остановки (SSE, обработчики). */
export async function mountInbox(chat: ChatApi, host: HTMLElement, o: InboxOptions = {}): Promise<() => void> {
  const doc = o.doc ?? document;
  const w = o.win ?? window;
  host.innerHTML = inboxFrameHtml();
  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel) as T;
  const list = q<HTMLElement>('[data-ib-list]');
  const right = q<HTMLElement>('[data-ib-right]');
  const pop = q<HTMLElement>('[data-ib-pop]');
  const search = q<HTMLInputElement>('[data-ib-q]');

  let chats: ChatListItem[] = [];
  let hasMore = false;
  let loadingMore = false;
  let filter: InboxFilter = 'all';
  let channelId: number | null = null;
  let channels: InboxChannel[] = [];
  let currentId: number | null = null;
  let closeChat: ((() => void) & { handleEvent?: (ev: ChatEvent) => void }) | null = null;
  let stopEvents: (() => void) | null = null;
  let badge = 0;
  let closed = false;

  const setBadge = (n: number) => {
    badge = n;
    o.onBadge?.(n);
  };
  const renderList = () => {
    list.innerHTML = chats.length
      ? chats.map((c) => chatRowHtml(c, currentId)).join('') + (hasMore ? '<button type="button" class="rfm-ib-more-btn" data-ib="more">Показать ещё</button>' : '')
      : `<div class="rfm-ib-empty">${filter === 'unanswered' ? 'Неотвеченных нет' : filter === 'mine' ? 'Ваших чатов пока нет' : 'Чатов пока нет'}</div>`;
  };
  const renderTitle = () => {
    q('[data-ib-title]').textContent = inboxHeaderTitle(channels, channelId);
  };

  const load = async (append = false) => {
    try {
      const r = await chat.inbox({ filter, channelId, q: search.value.trim().length >= 2 ? search.value.trim() : '', before: append ? (chats.at(-1)?.id ?? null) : null });
      chats = append ? [...chats, ...r.chats.filter((c) => !chats.some((x) => x.id === c.id))] : r.chats;
      hasMore = r.hasMore;
      setBadge(r.unansweredChats);
      renderList();
    } catch (err) {
      list.innerHTML = `<div class="rfm-ib-empty">${esc((err as Error).message)}</div>`;
    }
  };

  const openChat = async (id: number) => {
    currentId = id;
    renderList();
    closeChat?.();
    const item = chats.find((c) => c.id === id);
    closeChat = (await openChatWindow(chat, {
      ctx: { chatId: id },
      doc,
      win: w,
      embed: right,
      onCounters: (chatId, unanswered, answered) => applyCounters(chatId, unanswered, answered),
      onSent: (chatId) => applyCounters(chatId, 0, chats.find((c) => c.id === chatId)?.unanswered ?? 0, true),
    })) as typeof closeChat;
    if (item) list.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' });
  };

  /** Счётчики чата изменились (SSE, ответ, кнопка): строка и общий значок. */
  const applyCounters = (chatId: number, unanswered: number, answered: number, lift = false) => {
    const item = chats.find((c) => c.id === chatId);
    if (item) {
      const wasRed = (item.unanswered ?? 0) > 0;
      item.unanswered = unanswered;
      item.answered = answered;
      item.unread = unanswered;
      if (wasRed && unanswered === 0) setBadge(Math.max(0, badge - 1));
      if (!wasRed && unanswered > 0) setBadge(badge + 1);
      if (lift) item.lastAt = new Date().toISOString();
    }
    if (filter === 'unanswered' && item && unanswered === 0) chats = chats.filter((c) => c.id !== chatId);
    chats.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (a.lastAt < b.lastAt ? 1 : -1));
    renderList();
  };

  const onEvent = (ev: ChatEvent) => {
    if (closed) return;
    closeChat?.handleEvent?.(ev);
    const item = chats.find((c) => c.id === ev.chatId);
    if (ev.type === 'counters') {
      if (!item) {
        // Новый чат, которого в списке нет: подтянуть его строку и поднять наверх.
        void chat.chats({ chatId: ev.chatId }).then((v) => {
          const c = v.chats[0];
          if (!c || chats.some((x) => x.id === c.id)) return;
          if (filter === 'mine' || (channelId && c.channelId !== channelId)) return;
          chats = [c, ...chats];
          applyCounters(c.id, ev.unanswered, ev.answered);
        }).catch(() => undefined);
        return;
      }
      if (ev.lastAt) item.lastAt = ev.lastAt;
      applyCounters(ev.chatId, ev.unanswered, ev.answered);
      return;
    }
    if (ev.type === 'message' && item) {
      void chat.chats({ chatId: ev.chatId }).then((v) => {
        const fresh = v.chats[0];
        if (!fresh) return;
        item.last = fresh.last;
        item.lastAt = fresh.lastAt;
        chats.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (a.lastAt < b.lastAt ? 1 : -1));
        renderList();
      }).catch(() => undefined);
    }
  };

  const showChannels = () => {
    pop.innerHTML = `<div class="rfm-ib-menu" style="left:300px;top:44px"><button type="button" data-ib="pick-channel" data-id="0" aria-pressed="${!channelId}">Все каналы</button>${channels.map((c) => `<button type="button" data-ib="pick-channel" data-id="${c.id}" aria-pressed="${c.id === channelId}">${kindBadge(c.kind)} ${esc(c.title)}${c.connected ? '' : ' · не подключён'}</button>`).join('')}</div>`;
  };
  const showRowMenu = (id: number, anchor: HTMLElement) => {
    const item = chats.find((c) => c.id === id);
    if (!item) return;
    const r = anchor.getBoundingClientRect();
    const hostR = host.getBoundingClientRect();
    pop.innerHTML = `<div class="rfm-ib-menu" style="left:${Math.max(8, r.left - hostR.left - 200)}px;top:${r.bottom - hostR.top + 4}px">
<button type="button" data-ib="row-deal" data-id="${id}">Открыть сделку</button>
<button type="button" data-ib="row-pin" data-id="${id}">${item.pinned ? 'Открепить' : 'Закрепить'}</button>
${(item.unanswered ?? 0) > 0 ? `<button type="button" data-ib="row-noreply" data-id="${id}">Отвечать не нужно</button>` : ''}
</div>`;
  };

  host.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-ib]');
    if (!btn) {
      if (!target.closest('.rfm-ib-menu')) pop.innerHTML = '';
      return;
    }
    const id = Number(btn.dataset.id);
    switch (btn.dataset.ib) {
      case 'open':
        if (target.closest('[data-ib="row-menu"]')) return;
        return void openChat(id);
      case 'row-menu':
        e.stopPropagation();
        return showRowMenu(id, btn);
      case 'row-deal': {
        pop.innerHTML = '';
        void chat.chats({ chatId: id }).then((v) => {
          const cid = v.contacts[0]?.id;
          if (!cid) return w.alert('Чат не привязан к контакту — откройте его и нажмите «Сделки» → «Создать сделку»');
          void chat.contactLeads(cid).then((r) => {
            const lead = r.leads[0];
            if (lead) w.open(`/leads/detail/${lead.id}`, '_blank');
            else w.alert('У контакта нет сделок');
          });
        });
        return;
      }
      case 'row-pin': {
        pop.innerHTML = '';
        const item = chats.find((c) => c.id === id);
        if (!item) return;
        void chat.pin(id, !item.pinned).then(() => load());
        return;
      }
      case 'row-noreply':
        pop.innerHTML = '';
        void chat.noReply(id).then((r) => applyCounters(id, 0, r.answered));
        return;
      case 'filter':
        filter = (btn.dataset.f as InboxFilter) ?? 'all';
        host.querySelectorAll<HTMLElement>('[data-ib="filter"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));
        return void load();
      case 'channels':
        return pop.innerHTML ? void (pop.innerHTML = '') : showChannels();
      case 'pick-channel':
        channelId = id || null;
        pop.innerHTML = '';
        renderTitle();
        return void load();
      case 'more':
        if (loadingMore) return;
        loadingMore = true;
        void load(true).finally(() => (loadingMore = false));
        return;
      default:
        return;
    }
  });
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 300);
  });
  list.addEventListener('scroll', () => {
    if (hasMore && !loadingMore && list.scrollTop + list.clientHeight >= list.scrollHeight - 60) {
      loadingMore = true;
      void load(true).finally(() => (loadingMore = false));
    }
  });

  channels = (await chat.inboxChannels().catch(() => ({ channels: [] }))).channels;
  renderTitle();
  await load();
  stopEvents = await chat.events([], onEvent, w, 'inbox').catch(() => null);

  return () => {
    closed = true;
    stopEvents?.();
    closeChat?.();
    host.innerHTML = '';
  };
}
