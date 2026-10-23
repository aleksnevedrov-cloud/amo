import { mmss } from './day-analyze.ts';
import type { CallTranscript } from './stt.ts';

/**
 * RFD-AI-AGENT-CALLS-DAY-FULL, пп. 1–3: хронология общения с клиентом за день по сделке — звонки, Wazzup, чаты amoCRM,
 * диалог AI-агента, примечания менеджеров, почта — одной лентой с метками источника и времени МСК. Дубли (одно сообщение
 * из Wazzup и из чата amo) считаются один раз; при превышении лимита входа сначала сокращается почта, затем старые
 * сообщения; звонки не обрезаются.
 */

export type TimelineSource = 'call' | 'wazzup' | 'amo_chat' | 'agent' | 'note' | 'email';
export type TimelineAuthor = 'client' | 'manager' | 'agent';

export interface TimelineItem {
  /** Уникальный id в пределах сделки: call:<id>, wz:<id>, chat:<id>, agent:<id>, note:<id>, mail:<id>. */
  id: string;
  at: Date;
  source: TimelineSource;
  /** Канал мессенджера (whatsapp / telegram / max / avito / jivo …), для подписи. */
  channel?: string;
  direction: 'in' | 'out';
  author: TimelineAuthor;
  text: string;
  /** Письмо: тема; звонок — длительность и расшифровка. */
  subject?: string;
  durationSec?: number;
  callId?: number;
  transcript?: CallTranscript;
  attachments?: string[];
  /** RFD-AI-AGENT-WA-FILES: файлы с извлечённым текстом (Wazzup — документы и картинки обеих сторон, письма — вложения). */
  files?: TimelineFile[];
}

export interface TimelineFile {
  name: string;
  /** Извлечённый текст; null — не разобран (статус в note). */
  text: string | null;
  /** «аудио», «видео», «не разобран: …», «разбор ещё идёт». */
  note?: string;
}

const MSK = 'Europe/Moscow';
export const timeMsk = (d: Date): string => new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24/, '00');

const SOURCE_LABEL: Record<TimelineSource, string> = { call: 'Звонок', wazzup: 'Мессенджер', amo_chat: 'Чат amoCRM', agent: 'AI-агент', note: 'Примечание менеджера', email: 'Письмо' };
const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX', avito: 'Avito', jivo: 'JivoSite', jivosite: 'JivoSite', instagram: 'Instagram', vk: 'VK', viber: 'Viber' };

export const channelLabel = (ch: string | undefined, fallback: string): string => (ch ? (CHANNEL_LABEL[ch.toLowerCase()] ?? ch) : fallback);

/** Автор для ленты: по author; у звонка роли внутри расшифровки. */
const authorLabel = (a: TimelineAuthor): string => (a === 'client' ? 'Клиент' : a === 'agent' ? 'AI-агент' : 'Менеджер');

/** Убрать из письма цитаты (строки с «>», блоки «--- Original message ---», «Отправлено из…») и подписи («-- »). */
export function stripEmailQuotes(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^(-{2,}\s*$|__+\s*$)/.test(line.trim())) break;
    if (/^(On .+ wrote:|\d{1,2}[./]\d{1,2}[./]\d{2,4}.{0,40}(писал|написал|wrote)|-{3,}\s*(Original Message|Пересылаемое сообщение|Исходное сообщение)|From:|От:|Отправлено с|Sent from|С уважением,?$|Best regards,?$)/i.test(line.trim())) break;
    if (line.trimStart().startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Убрать дубли: одно и то же сообщение из Wazzup и из чата amoCRM (тот же текст, то же направление, разница ≤ 3 мин) —
 * остаётся первое по времени. Сортировка по времени.
 */
export function dedupeTimeline(items: TimelineItem[]): TimelineItem[] {
  const sorted = [...items].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const kept: TimelineItem[] = [];
  const seen = new Set<string>();
  for (const it of sorted) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (it.source === 'wazzup' || it.source === 'amo_chat' || it.source === 'agent') {
      const key = `${it.direction}:${norm(it.text)}`;
      const dup = kept.find((k) => (k.source === 'wazzup' || k.source === 'amo_chat' || k.source === 'agent') && `${k.direction}:${norm(k.text)}` === key && Math.abs(k.at.getTime() - it.at.getTime()) <= 3 * 60_000 && k.source !== it.source);
      if (dup) {
        // Wazzup предпочтительнее чата amo: известен канал (WhatsApp / Telegram / MAX).
        if (it.source === 'wazzup' && dup.source === 'amo_chat') kept[kept.indexOf(dup)] = { ...it, at: dup.at };
        continue;
      }
    }
    // Письмо из карточки amo и то же письмо из ящика (IMAP → диалог): та же тема и направление в пределах 10 минут.
    if (it.source === 'email') {
      const key = `${it.direction}:${norm((it.subject ?? '').replace(/^(re|fwd?|ответ):\s*/i, ''))}`;
      const dup = kept.find((k) => k.source === 'email' && `${k.direction}:${norm((k.subject ?? '').replace(/^(re|fwd?|ответ):\s*/i, ''))}` === key && Math.abs(k.at.getTime() - it.at.getTime()) <= 10 * 60_000);
      if (dup) continue;
    }
    kept.push(it);
  }
  return kept;
}

/** Есть ли в ленте общение не только от AI-агента: звонок с расшифровкой, сообщение клиента или менеджера, письмо, примечание. */
export const hasHumanActivity = (items: TimelineItem[]): boolean => items.some((it) => it.source === 'call' || it.author !== 'agent');

/** Файлы записи: «файл X: текст» или «файл X (аудио)». */
export function formatFiles(files: TimelineFile[] | undefined): string {
  if (!files?.length) return '';
  return files.map((f) => `\nФайл ${f.name}${f.text ? `: ${f.text}` : f.note ? ` (${f.note})` : ''}`).join('');
}

export function formatItem(it: TimelineItem): string {
  const t = timeMsk(it.at);
  const files = formatFiles(it.files);
  switch (it.source) {
    case 'call': {
      const lines = (it.transcript?.segments ?? []).map((s) => `${s.role === 'manager' ? 'Менеджер' : s.role === 'client' ? 'Клиент' : `Говорящий ${s.speaker ?? '?'}`}: ${s.text}`);
      return `${t} Звонок ${it.direction === 'in' ? 'вх.' : 'исх.'} (${mmss(it.durationSec ?? 0)}) [${it.id}]:\n${lines.join('\n') || it.transcript?.text || '(расшифровки нет)'}`;
    }
    case 'email': {
      const named = new Set((it.files ?? []).map((f) => f.name));
      const rest = (it.attachments ?? []).filter((a) => !named.has(a));
      const att = rest.length ? `\nВложения: ${rest.join(', ')}` : '';
      return `${t} Письмо ${it.direction === 'in' ? 'вх.' : 'исх.'} [${it.id}] Тема: ${it.subject ?? '(без темы)'}\n${it.text}${att}${files}`;
    }
    case 'note':
      return `${t} Примечание менеджера [${it.id}]: ${it.text}${files}`;
    default: {
      const who = it.files?.length ? `${authorLabel(it.author)} — ${it.author === 'client' ? 'прислал' : 'отправил'} файл` : authorLabel(it.author);
      return `${t} ${channelLabel(it.channel, SOURCE_LABEL[it.source])} ${who} [${it.id}]${it.text ? `: ${it.text}` : ''}${files}`;
    }
  }
}

export const MAX_INPUT_CHARS = 60_000;
const EMAIL_SHORT_CHARS = 1500;
/** Текст файла в ленте: до этого предела всегда; при превышении общего лимита — сначала укорачивается до FILE_MIN_CHARS. */
export const FILE_TEXT_CHARS = 4000;
const FILE_MIN_CHARS = 600;

export interface TimelineText {
  text: string;
  /** Что сократили: пусто — ничего. */
  truncated: string[];
  /** Элементы, вошедшие в текст. */
  used: TimelineItem[];
}

const cutFiles = (it: TimelineItem, max: number): TimelineItem => (it.files?.some((f) => f.text && f.text.length > max) ? { ...it, files: it.files.map((f) => (f.text && f.text.length > max ? { ...f, text: `${f.text.slice(0, max)}…` } : f)) } : it);

/** Лента текстом с ограничением: сначала короче тексты файлов, затем письма, затем убираются старые сообщения (не звонки). */
export function timelineText(items: TimelineItem[], limit = MAX_INPUT_CHARS): TimelineText {
  let current = items.map((it) => cutFiles({ ...it }, FILE_TEXT_CHARS));
  const truncated: string[] = [];
  const render = () => current.map(formatItem).join('\n\n');
  let text = render();
  if (text.length > limit && current.some((it) => it.files?.some((f) => f.text && f.text.length > FILE_MIN_CHARS))) {
    current = current.map((it) => cutFiles(it, FILE_MIN_CHARS));
    truncated.push('тексты файлов сокращены');
    text = render();
  }
  if (text.length > limit) {
    let cut = 0;
    current = current.map((it) => (it.source === 'email' && it.text.length > EMAIL_SHORT_CHARS ? (cut++, { ...it, text: `${it.text.slice(0, EMAIL_SHORT_CHARS)}…` }) : it));
    if (cut) truncated.push(`письма сокращены (${cut})`);
    text = render();
  }
  let dropped = 0;
  while (text.length > limit) {
    const idx = current.findIndex((it) => it.source !== 'call');
    if (idx < 0) break;
    current.splice(idx, 1);
    dropped++;
    text = render();
  }
  if (dropped) truncated.push(`старые сообщения не вошли (${dropped})`);
  return { text, truncated, used: current };
}

export interface TimelineCounts {
  calls: number;
  messages: number;
  emails: number;
  notes: number;
  totalCallDuration: number;
}

export function countTimeline(items: TimelineItem[]): TimelineCounts {
  return {
    calls: items.filter((i) => i.source === 'call').length,
    messages: items.filter((i) => i.source === 'wazzup' || i.source === 'amo_chat' || i.source === 'agent').length,
    emails: items.filter((i) => i.source === 'email').length,
    notes: items.filter((i) => i.source === 'note').length,
    totalCallDuration: items.filter((i) => i.source === 'call').reduce((s, i) => s + (i.durationSec ?? 0), 0),
  };
}
