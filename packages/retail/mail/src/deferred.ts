import { readFile } from 'node:fs/promises';
import type { AmoApiClient } from '@core/amo';
import type { DialogRepo, JournalRepo, MailAttachmentsRepo, SettingsRepo, WidgetSettings } from '@core/db';
import { DEFERRED_MARK } from './poller.ts';

/**
 * RFD-AI-AGENT-FILES-PRIORITY, п. 2: вложения писем, отложенные по дневному лимиту (mail_attachments.extract_status =
 * 'deferred'), разбираются автоматически — проход раз в 5 минут вместе с файлами Wazzup: в новые сутки (лимит обнулился) или
 * сразу после повышения лимита. После разбора текст дописывается в историю сделки вместо пометки «разбор отложен…» (контекст
 * агента) и в открытую задачу сделки, поставленную из-за лимита («…из-за дневного лимита»).
 */

export interface DeferredMailDeps {
  attachments: Pick<MailAttachmentsRepo, 'listDeferred' | 'setExtract'>;
  settings: Pick<SettingsRepo, 'get' | 'listAccountIds'>;
  journal: Pick<JournalRepo, 'add'>;
  dialog: Pick<DialogRepo, 'clientMessagesMentioning' | 'updateText' | 'addMessage'>;
  amo(accountId: number): Promise<Pick<AmoApiClient, 'openLeadTasks' | 'updateTaskText'>>;
  documents: {
    analyze(input: { accountId: number; leadId: number | null; source: 'email'; filename: string; mime: string; bytes: Uint8Array; settings: WidgetSettings; priority: 'deferred' }): Promise<{ id: number; kind: string; text: string; costUsd: number; model: string }>;
  } | null;
  /** Чтение файла с тома (в тестах подменяется). */
  readFile?: (path: string) => Promise<Uint8Array>;
}

export interface DeferredMailResult {
  accounts: number;
  picked: number;
  done: number;
  stillLimited: number;
  failed: number;
  tasksUpdated: number;
}

const PER_RUN = 20;
/** Столько знаков разбора дописывается в задачу менеджера. */
const TASK_TEXT_CHARS = 600;
const TASK_LIMIT_RE = /дневн[а-яё]* лимит/i;

/** Пометки в истории сделки, которые заменяются текстом разбора: новая («разбор отложен…») и прежняя («разобрать не удалось: … лимит …»). */
export function replaceDeferredMark(text: string, filename: string, replacement: string): string | null {
  const name = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // До конца строки (в тексте ошибки бывают свои скобки: «…файлов (100)»).
  const re = new RegExp(`\\(во вложении файл «${name}»(?: — ${DEFERRED_MARK}[^\\n]*|, разобрать не удалось: [^\\n]*лимит[^\\n]*)\\)`, 'iu');
  if (!re.test(text)) return null;
  return text.replace(re, replacement);
}

export async function runDeferredMailFiles(d: DeferredMailDeps, log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }): Promise<DeferredMailResult> {
  const r: DeferredMailResult = { accounts: 0, picked: 0, done: 0, stillLimited: 0, failed: 0, tasksUpdated: 0 };
  if (!d.documents) return r;
  for (const accountId of await d.settings.listAccountIds()) {
    r.accounts++;
    let settings: WidgetSettings;
    try {
      settings = (await d.settings.get(accountId)).settings;
    } catch (err) {
      log.warn({ accountId, err: (err as Error).message }, 'deferred-mail-files: настройки не прочитаны');
      continue;
    }
    if (!settings.vision.autoParse) continue;
    const rows = await d.attachments.listDeferred(accountId, PER_RUN);
    r.picked += rows.length;
    for (const row of rows) {
      let bytes: Uint8Array;
      try {
        bytes = await (d.readFile ?? ((p: string) => readFile(p)))(row.storagePath);
      } catch (err) {
        r.failed++;
        await d.attachments.setExtract(row.id, { error: `файл не прочитан: ${(err as Error).message}` });
        await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'error', summary: `Отложенное вложение «${row.filename}» не разобрано: файл на томе не прочитан — ${(err as Error).message}`, details: { attachmentId: row.id, path: row.storagePath } });
        continue;
      }
      try {
        const res = await d.documents.analyze({ accountId, leadId: row.leadId, source: 'email', filename: row.filename, mime: row.mime, bytes, settings, priority: 'deferred' });
        await d.attachments.setExtract(row.id, { text: res.text });
        r.done++;
        let taskId: number | null = null;
        let context = 'в историю не дописан (сделка не привязана)';
        if (row.leadId) {
          context = await updateContext(d, accountId, row.leadId, row.filename, res.text);
          try {
            taskId = await appendToLimitTask(d, accountId, row.leadId, row.filename, res.text);
            if (taskId) r.tasksUpdated++;
          } catch (err) {
            await d.journal.add({ accountId, leadId: row.leadId, kind: 'error', summary: `Отложенное вложение «${row.filename}»: задача не дополнена — ${(err as Error).message}`, details: { attachmentId: row.id } });
          }
        }
        await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'document', summary: `Разобрано отложенное вложение «${row.filename}» (${res.kind}, отложенный): ${context}${taskId ? `; содержимое дописано в задачу ${taskId}` : ''}`, details: { documentId: res.id, model: res.model, attachmentId: row.id, priority: 'deferred', taskId, text: res.text.slice(0, 2000) }, costUsd: res.costUsd, costRub: res.costUsd * settings.billing.usdRubRate });
      } catch (err) {
        if ((err as { stage?: string }).stage === 'limit') {
          r.stillLimited++;
          continue; // лимит всё ещё исчерпан — остаётся «отложено», следующий проход
        }
        r.failed++;
        await d.attachments.setExtract(row.id, { error: (err as Error).message });
        await d.journal.add({ accountId, ...(row.leadId ? { leadId: row.leadId } : {}), kind: 'error', summary: `Отложенное вложение «${row.filename}» не разобрано: ${(err as Error).message}`, details: { attachmentId: row.id } });
      }
    }
  }
  if (r.picked) log.info({ ...r }, 'deferred-mail-files: отложенные вложения');
  return r;
}

/** Текст разбора — в историю сделки вместо пометки об отложенном разборе; пометки нет — отдельным сообщением клиента. */
async function updateContext(d: DeferredMailDeps, accountId: number, leadId: number, filename: string, text: string): Promise<string> {
  for (const m of await d.dialog.clientMessagesMentioning(accountId, leadId, `файл «${filename}»`)) {
    const replaced = replaceDeferredMark(m.text, filename, text);
    if (replaced !== null) {
      await d.dialog.updateText(m.id, replaced);
      return 'текст дописан в письмо в истории сделки';
    }
  }
  await d.dialog.addMessage(accountId, leadId, 'client', `Содержимое вложения «${filename}» из письма (разобрано после дневного лимита):\n${text}`);
  return 'текст добавлен в историю сделки отдельным сообщением';
}

/** Открытая задача сделки, поставленная из-за дневного лимита, — дописать краткое содержимое файла; нет такой — null. */
async function appendToLimitTask(d: DeferredMailDeps, accountId: number, leadId: number, filename: string, text: string): Promise<number | null> {
  const api = await d.amo(accountId);
  const task = (await api.openLeadTasks(leadId)).find((t) => TASK_LIMIT_RE.test(t.text) && !t.text.includes(`Содержимое файла «${filename}»`));
  if (!task) return null;
  const short = text.replace(/\s+/g, ' ').trim();
  await api.updateTaskText(task.id, `${task.text.trimEnd()}\n\nСодержимое файла «${filename}» (разобрано после дневного лимита): ${short.length > TASK_TEXT_CHARS ? `${short.slice(0, TASK_TEXT_CHARS)}…` : short}`);
  return task.id;
}
