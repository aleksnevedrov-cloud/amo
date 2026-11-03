import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Старые форматы Office в спецификациях (RFD-AI-AGENT-OPT-MAIL-READ-6, п. 2): .doc, .rtf, .odt → .docx,
 * .xls, .ods → .xlsx через LibreOffice (он уже есть в образе опта ради PDF). Дальше файл разбирает
 * @core/docs как обычный DOCX/XLSX. Нет soffice или не сконвертировалось — понятная ошибка, не «формат
 * не поддерживается».
 */

const run = promisify(execFile);

export interface OfficeFile {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

const LEGACY: Record<string, { to: 'docx' | 'xlsx'; mime: string }> = {
  doc: { to: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  rtf: { to: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  odt: { to: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xls: { to: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ods: { to: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

const MIME_EXT: Record<string, string> = {
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
};

/** Во что конвертировать по имени и MIME; null — формат современный или чужой, конвертация не нужна. */
export function legacyTarget(filename: string, mime: string): { from: string; to: 'docx' | 'xlsx'; mime: string } | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const from = LEGACY[ext] ? ext : (MIME_EXT[mime.toLowerCase().split(';')[0]?.trim() ?? ''] ?? '');
  const t = LEGACY[from];
  return t ? { from, to: t.to, mime: t.mime } : null;
}

export class ConvertError extends Error {
  override name = 'ConvertError';
}

/**
 * Конвертация через soffice --headless --convert-to; отдельный профиль на процесс (параллельные вызовы
 * на общем профиле падают). Возвращает файл с новым именем и MIME; не старый формат — тот же объект.
 */
export async function convertLegacyOffice(file: OfficeFile, opts: { timeoutMs?: number; soffice?: string } = {}): Promise<OfficeFile> {
  const target = legacyTarget(file.filename, file.mime);
  if (!target) return file;
  const dir = await mkdtemp(join(tmpdir(), 'kp-convert-'));
  try {
    const src = join(dir, `in.${target.from}`);
    await writeFile(src, file.bytes);
    try {
      await run(opts.soffice ?? 'soffice', ['--headless', `-env:UserInstallation=file:///tmp/lo-${process.pid}`, '--convert-to', target.to, '--outdir', dir, src], { timeout: opts.timeoutMs ?? 90_000 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      if (e.code === 'ENOENT') throw new ConvertError(`LibreOffice не установлен — .${target.from} не конвертируется в .${target.to}`);
      if (e.killed) throw new ConvertError(`LibreOffice не успел сконвертировать .${target.from} за ${Math.round((opts.timeoutMs ?? 90_000) / 1000)} с`);
      throw new ConvertError(`LibreOffice: .${target.from} → .${target.to} не удалось: ${(e.stderr || e.message || '').trim().slice(0, 300)}`);
    }
    const out = await readFile(join(dir, `in.${target.to}`)).catch(() => null);
    if (!out || !out.byteLength) throw new ConvertError(`LibreOffice: .${target.from} → .${target.to} — результат пустой`);
    return { filename: file.filename.replace(/\.[a-z0-9]+$/i, '') + `.${target.to}`, mime: target.mime, bytes: new Uint8Array(out) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
