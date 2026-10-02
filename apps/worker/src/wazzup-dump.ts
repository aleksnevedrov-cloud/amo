import { normalizePhone, type JournalRepo, type SecretsRepo, type WazzupDump, type WazzupDumpRepo, type WazzupMessage } from '@ai-door/db';
import type { JobLogger } from './jobs.ts';

const TECH_API = 'https://tech.wazzup24.com/v2/messages/messages_dump';
const SYSTEM_TEXT_RE = /===\s*SYSTEM\s+WZ\s*===|^\s*Сообщение не отправлено/iu;
const MAX_CSV_BYTES = 50 * 1024 * 1024;

export interface DumpDeps {
  dumps: WazzupDumpRepo;
  secrets: SecretsRepo;
  journal: JournalRepo;
  fetch?: typeof fetch;
}

/** Разбор CSV: кавычки, переводы строк внутри полей, разделитель «,» или «;» (по заголовку). */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const nl = src.indexOf('\n');
  const first = src.slice(0, nl < 0 ? src.length : nl);
  const delim = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-zа-яё0-9]/g, '');

/** Номер колонки по списку возможных имён: сначала точное совпадение, потом вхождение. */
function col(header: string[], names: string[]): number {
  const h = header.map(norm);
  for (const n of names) { const i = h.indexOf(norm(n)); if (i >= 0) return i; }
  for (const n of names) { const i = h.findIndex((x) => x.includes(norm(n))); if (i >= 0) return i; }
  return -1;
}

export interface CsvMapping {
  messageId: number; channelId: number; chatId: number; chatType: number; dateTime: number; type: number;
  isEcho: number; direction: number; text: number; status: number; phone: number; author: number;
}

export function mapColumns(header: string[]): CsvMapping {
  return {
    messageId: col(header, ['messageId', 'message_id', 'id', 'uuid']),
    channelId: col(header, ['channelId', 'channel_id', 'channel']),
    chatId: col(header, ['chatId', 'chat_id', 'chat']),
    chatType: col(header, ['chatType', 'chat_type', 'transport', 'messenger']),
    dateTime: col(header, ['dateTime', 'date_time', 'datetime', 'createdAt', 'created_at', 'date', 'time', 'дата']),
    type: col(header, ['type', 'messageType', 'content_type']),
    isEcho: col(header, ['isEcho', 'is_echo', 'echo', 'isOutgoing', 'outgoing']),
    direction: col(header, ['direction', 'направление']),
    text: col(header, ['text', 'message', 'body', 'content', 'текст', 'сообщение']),
    status: col(header, ['status', 'статус']),
    phone: col(header, ['phone', 'contactPhone', 'contact_phone', 'recipient', 'телефон', 'получатель']),
    author: col(header, ['authorName', 'author_name', 'author', 'managerName', 'manager', 'менеджер', 'автор']),
  };
}

const TRUE_RE = /^(true|1|yes|да|y)$/i;

/** Дата из CSV; без зоны — UTC (часовой пояс аккаунта Wazzup GMT+0). */
export function parseCsvDate(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{10}(\d{3})?$/.test(s)) return new Date(s.length === 10 ? Number(s) * 1000 : Number(s));
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!, +m[4]!, +m[5]!, +(m[6] ?? 0)));
  return null;
}

export function rowToMessage(r: string[], m: CsvMapping): WazzupMessage | null {
  const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const messageId = get(m.messageId);
  const chatId = get(m.chatId);
  const sentAt = parseCsvDate(get(m.dateTime));
  if (!messageId || !chatId || !sentAt) return null;
  const chatType = get(m.chatType).toLowerCase() || null;
  const dir = get(m.direction).toLowerCase();
  const echo = TRUE_RE.test(get(m.isEcho)) || /^(out|исход)/.test(dir);
  const text = get(m.text);
  const phoneRaw = get(m.phone) || (chatType === null || chatType.startsWith('whats') ? chatId : '');
  return {
    messageId,
    channelId: get(m.channelId) || null,
    chatId,
    chatType,
    phone: phoneRaw ? normalizePhone(phoneRaw) : null,
    direction: echo ? 'out' : 'in',
    author: echo ? 'manager' : 'client',
    text,
    status: get(m.status) || null,
    isSystem: SYSTEM_TEXT_RE.test(text) || /^(system|service)/i.test(get(m.type)),
    sentAt,
    source: 'dump',
  };
}

const day = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: 'UTC' });

async function fail(d: DumpDeps, dump: WazzupDump, error: string): Promise<void> {
  await d.dumps.update(dump.id, { status: 'failed', error: error.slice(0, 500), finished: true });
  await d.journal.add({ accountId: dump.accountId, kind: 'error', summary: `Wazzup: выгрузка истории ${day(dump.startAt)}–${day(dump.endAt)} не удалась: ${error.slice(0, 200)}` });
}

async function importCsv(d: DumpDeps, dump: WazzupDump, url: string, f: typeof fetch, log: JobLogger): Promise<void> {
  const res = await f(url);
  if (!res.ok) return fail(d, dump, `скачивание CSV — HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_CSV_BYTES) return fail(d, dump, `CSV слишком большой: ${buf.length} байт`);
  const rows = parseCsv(buf.toString('utf8'));
  const header = rows[0] ?? [];
  const columns = header.join(' | ').slice(0, 2000);
  const m = mapColumns(header);
  const missing = (['messageId', 'chatId', 'dateTime', 'text'] as const).filter((k) => m[k] < 0);
  await d.dumps.update(dump.id, { url, columns, rowsTotal: Math.max(rows.length - 1, 0) });
  if (missing.length) return fail(d, dump, `не распознаны колонки CSV: ${missing.join(', ')}; заголовок: ${columns.slice(0, 300)}`);
  let inserted = 0;
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const msg = rowToMessage(r, m);
    if (msg && (await d.dumps.insertFromDump(dump.accountId, msg))) inserted++;
    else skipped++;
  }
  await d.dumps.update(dump.id, { inserted, skipped, status: 'done', finished: true });
  log.info({ dumpId: dump.id, rows: rows.length - 1, inserted, skipped }, 'wazzup: история импортирована');
  await d.journal.add({
    accountId: dump.accountId,
    kind: 'import',
    summary: `Wazzup: история ${day(dump.startAt)}–${day(dump.endAt)} загружена: ${inserted} новых, ${skipped} пропущено из ${rows.length - 1}`,
    details: { dumpId: dump.id, channelId: dump.channelId, columns: header, mapping: m },
  });
}

/** Раз в минуту: заказать выгрузку для новых заявок, опросить статус, скачать и импортировать готовые. */
export async function runWazzupDumps(d: DumpDeps, log: JobLogger): Promise<void> {
  const f = d.fetch ?? fetch;
  for (const dump of await d.dumps.active()) {
    try {
      const apiKey = await d.secrets.get(dump.accountId, 'wazzup');
      if (!apiKey) { await fail(d, dump, 'ключ API Wazzup не сохранён'); continue; }
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      if (dump.status === 'queued' || !dump.exportId) {
        const body = { start_at: dump.startAt.toISOString(), end_at: dump.endAt.toISOString(), ...(dump.channelId ? { channel_id: dump.channelId } : {}) };
        const res = await f(TECH_API, { method: 'POST', headers, body: JSON.stringify(body) });
        const json = (await res.json().catch(() => null)) as { data?: { status?: string; export_id?: string } } | null;
        if (!res.ok || !json?.data?.export_id) { await fail(d, dump, `Wazzup HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`); continue; }
        await d.dumps.update(dump.id, { exportId: json.data.export_id, status: 'pending' });
        log.info({ dumpId: dump.id, exportId: json.data.export_id }, 'wazzup: выгрузка заказана');
        continue;
      }
      const res = await f(`${TECH_API}/${encodeURIComponent(dump.exportId)}`, { headers });
      const json = (await res.json().catch(() => null)) as { data?: { status?: string; url?: string } } | null;
      if (!res.ok) { await fail(d, dump, `Wazzup HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`); continue; }
      const st = json?.data?.status ?? '';
      if (st === 'pending' || st === 'processing') {
        if (st !== dump.status) await d.dumps.update(dump.id, { status: st });
        continue;
      }
      if ((st === 'done' || st === 'webhook_failed') && json?.data?.url) { await importCsv(d, dump, json.data.url, f, log); continue; }
      await fail(d, dump, `неожиданный ответ Wazzup: ${JSON.stringify(json).slice(0, 300)}`);
    } catch (err) {
      log.warn({ dumpId: dump.id, err: (err as Error).message }, 'wazzup: ошибка выгрузки');
      await fail(d, dump, (err as Error).message);
    }
  }
}
