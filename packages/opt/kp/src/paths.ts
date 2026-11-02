import { isAbsolute, join, relative } from 'node:path';

/**
 * Пути файлов КП (RFD-AI-AGENT-OPT-KP-DOWNLOAD, дефект 2а): в базе хранятся относительно KP_FILES_ROOT
 * («kp/<аккаунт>/template.docx», «kp/<аккаунт>/<сделка>/KP-….pdf»), абсолютный путь собирается при чтении.
 * Так смена точки монтирования тома (/opt-data → /data) не ломает сборку: раньше в kp_settings лежал
 * абсолютный путь и после переноса сборка падала с ENOENT.
 */

/** Подкаталог файлов КП внутри KP_FILES_ROOT. */
export const KP_DIR = 'kp';

export const kpTemplateRel = (accountId: number): string => `${KP_DIR}/${accountId}/template.docx`;
export const kpLeadDirRel = (accountId: number, leadId: number): string => `${KP_DIR}/${accountId}/${leadId}`;

/** Абсолютный путь: относительный — от KP_FILES_ROOT, абсолютный (старые записи, свой каталог сертификатов) — как есть. */
export function resolveKpPath(filesRoot: string, p: string): string;
export function resolveKpPath(filesRoot: string, p: string | null | undefined): string | null;
export function resolveKpPath(filesRoot: string, p: string | null | undefined): string | null {
  if (!p) return null;
  return isAbsolute(p) ? p : join(filesRoot, p);
}

/**
 * Путь для записи в базу: внутри KP_FILES_ROOT — относительно него; абсолютный путь из другого корня со
 * вставкой «/kp/» (старый том /opt-data/kp/…) — от «kp/»; прочие абсолютные (чужой каталог сертификатов) — как есть.
 * То же правило — в миграции 005 для существующих записей.
 */
export function relativeKpPath(filesRoot: string, p: string): string {
  if (!isAbsolute(p)) return p;
  const rel = relative(filesRoot, p);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  const m = /\/kp\/(.*)$/.exec(p);
  return m ? `${KP_DIR}/${m[1]}` : p;
}

/** Ошибка файловой системы понятным текстом для журнала (дефект 2б: EACCES на /data/kp/<аккаунт> после копирования от root). */
export function describeFsError(err: unknown, path: string): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  const msg = (err as Error | null)?.message ?? String(err);
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `нет прав на запись в ${path} (${code}): каталог создан не от пользователя node — выполните на сервере «chown -R node:node /data» или пересоберите контейнер с entrypoint`;
    case 'ENOENT':
      return `нет файла или каталога ${path} (ENOENT): проверьте KP_FILES_ROOT и монтирование тома /data`;
    case 'ENOSPC':
      return `нет места на диске для ${path} (ENOSPC)`;
    default:
      return `${path}: ${msg}`;
  }
}

/** Имя файла для Content-Disposition в ASCII (кириллица транслитерируется, остальное — «_»); полное имя идёт в filename*. */
export function asciiFilename(name: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return [...name]
    .map((ch) => {
      if (/[\x20-\x7e]/.test(ch) && ch !== '"' && ch !== '\\') return ch;
      const low = ch.toLowerCase();
      const tr = map[low];
      if (tr === undefined) return '_';
      return ch === low ? tr : tr.charAt(0).toUpperCase() + tr.slice(1);
    })
    .join('');
}
