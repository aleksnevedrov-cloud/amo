import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hmacHex, safeEqualHex } from './crypto.ts';
import type { FileRecord, Store } from './store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Имя файла для заголовков и ссылок: без путей и управляющих символов. */
export function safeFileName(name: string, fallback = 'file'): string {
  // eslint-disable-next-line no-control-regex -- вырезаем управляющие символы
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return clean || fallback;
}

/**
 * Файлы переписки хранятся у нас (FILES_DIR/<uuid>), в amoCRM уходит подписанная ссылка
 * с chat.rf-dveri.ru со сроком жизни FILE_URL_TTL_DAYS (раздел 4 ТЗ).
 */
export class FileStore {
  constructor(
    private readonly store: Store,
    private readonly opts: { dir: string; secret: string; publicUrl: string; ttlDays: number; maxBytes: number },
  ) {}

  get maxBytes(): number {
    return this.opts.maxBytes;
  }

  async save(f: { accountId: number; channelId: number | null; data: Buffer; name: string; mime: string }): Promise<FileRecord> {
    if (f.data.length > this.opts.maxBytes) throw new Error('Файл больше допустимого размера');
    const id = randomUUID();
    await mkdir(this.opts.dir, { recursive: true });
    await writeFile(join(this.opts.dir, id), f.data, { flag: 'wx' });
    const rec: FileRecord = { id, accountId: f.accountId, name: safeFileName(f.name), mime: f.mime || 'application/octet-stream', size: f.data.length };
    await this.store.insertFile({ ...rec, channelId: f.channelId, sha256: createHash('sha256').update(f.data).digest('hex') });
    return rec;
  }

  private sign(id: string, exp: number): string {
    return hmacHex('sha256', this.opts.secret, `${id}.${exp}`);
  }

  signedUrl(file: Pick<FileRecord, 'id' | 'name'>, now: Date = new Date()): string {
    const exp = Math.floor(now.getTime() / 1000) + this.opts.ttlDays * 86400;
    const u = new URL(`/f/${file.id}/${encodeURIComponent(file.name)}`, this.opts.publicUrl);
    u.searchParams.set('e', String(exp));
    u.searchParams.set('s', this.sign(file.id, exp));
    return u.toString();
  }

  verify(id: string, e: string | undefined, s: string | undefined, now: Date = new Date()): 'ok' | 'expired' | 'bad' {
    if (!UUID.test(id) || !e || !/^\d{1,12}$/.test(e) || !s) return 'bad';
    if (!safeEqualHex(this.sign(id, Number(e)), s)) return 'bad';
    return Number(e) * 1000 < now.getTime() ? 'expired' : 'ok';
  }

  async read(id: string): Promise<Buffer> {
    if (!UUID.test(id)) throw new Error('bad id');
    return readFile(join(this.opts.dir, id));
  }
}
