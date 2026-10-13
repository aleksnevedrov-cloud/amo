// Старые форматы Office → DOCX/XLSX через LibreOffice; без soffice тесты конвертации пропускаются.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extract } from '@core/docs';
import { describe, expect, it } from 'vitest';
import { convertLegacyOffice, legacyTarget } from '../src/convert.ts';

const run = promisify(execFile);
const hasSoffice = await run('soffice', ['--version'], { timeout: 20_000 }).then(() => true, () => false);

describe('старые форматы Office', () => {
  it('какие файлы конвертируются: .doc/.rtf/.odt → docx, .xls/.ods → xlsx, по расширению или MIME; остальное — как есть', () => {
    expect(legacyTarget('Карточка Стройоптпоставка А (1) (2) (1).doc', 'application/octet-stream')).toEqual({ from: 'doc', to: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(legacyTarget('прайс.XLS', '')).toMatchObject({ from: 'xls', to: 'xlsx' });
    expect(legacyTarget('письмо', 'application/msword')).toMatchObject({ from: 'doc' });
    expect(legacyTarget('спец.rtf', 'text/rtf')).toMatchObject({ to: 'docx' });
    expect(legacyTarget('спец.docx', '')).toBeNull();
    expect(legacyTarget('спец.pdf', 'application/pdf')).toBeNull();
    expect(legacyTarget('фото.jpg', 'image/jpeg')).toBeNull();
  });

  it('не старый формат — файл возвращается без изменений; нет LibreOffice — понятная ошибка', async () => {
    const f = { filename: 'a.docx', mime: 'x', bytes: new Uint8Array([1, 2]) };
    expect(await convertLegacyOffice(f)).toBe(f);
    await expect(convertLegacyOffice({ filename: 'a.doc', mime: '', bytes: new Uint8Array([1]) }, { soffice: '/nonexistent/soffice' })).rejects.toThrow(/LibreOffice не установлен/);
  });

  it.skipIf(!hasSoffice)('.doc из письма → .docx, текст читается как у обычного DOCX; .rtf тоже', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kp-convert-test-'));
    try {
      // Исходный .doc делаем тем же LibreOffice из текста.
      const txt = join(dir, 'spec.txt');
      await writeFile(txt, 'Карточка ООО Стройоптпоставка\nДверь двухпольная 1400×2700, 2 шт\n', 'utf8');
      await run('soffice', ['--headless', `-env:UserInstallation=file:///tmp/lo-test-${process.pid}`, '--convert-to', 'doc', '--outdir', dir, txt], { timeout: 90_000 });
      const doc = await readFile(join(dir, 'spec.doc'));
      const out = await convertLegacyOffice({ filename: 'Карточка (1).doc', mime: 'application/msword', bytes: new Uint8Array(doc) });
      expect(out.filename).toBe('Карточка (1).docx');
      expect(out.mime).toContain('wordprocessingml');
      const text = (await extract(out.bytes, out.mime, out.filename)).text;
      expect(text).toContain('Стройоптпоставка');
      expect(text).toContain('1400×2700');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
