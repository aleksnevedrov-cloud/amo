import { readFileSync } from 'node:fs';
import { AccountsRepo, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asciiFilename, describeFsError, kpLeadDirRel, kpTemplateRel, relativeKpPath, resolveKpPath } from '../src/paths.ts';
import { KpRepo } from '../src/repo.ts';
import { freshOptDb } from './setup.ts';

describe('пути файлов КП относительно KP_FILES_ROOT (RFD-AI-AGENT-OPT-KP-DOWNLOAD, дефект 2а)', () => {
  it('относительный путь собирается от корня, абсолютный остаётся; путь для базы — относительный, старый том /opt-data → kp/…', () => {
    expect(kpTemplateRel(28528549)).toBe('kp/28528549/template.docx');
    expect(kpLeadDirRel(28528549, 30021357)).toBe('kp/28528549/30021357');
    expect(resolveKpPath('/data', 'kp/1/template.docx')).toBe('/data/kp/1/template.docx');
    expect(resolveKpPath('/data', '/opt-data/kp/1/template.docx')).toBe('/opt-data/kp/1/template.docx');
    expect(resolveKpPath('/data', null)).toBeNull();
    expect(relativeKpPath('/data', '/data/kp/1/30021357/KP-КП-2026-7.pdf')).toBe('kp/1/30021357/KP-КП-2026-7.pdf');
    expect(relativeKpPath('/data', '/opt-data/kp/1/template.docx')).toBe('kp/1/template.docx');
    expect(relativeKpPath('/data', 'kp/1/template.docx')).toBe('kp/1/template.docx');
    // Свой каталог сертификатов вне тома — как есть.
    expect(relativeKpPath('/data', '/srv/certs')).toBe('/srv/certs');
  });

  it('ошибки файловой системы — понятным текстом; имя файла для Content-Disposition в ASCII', () => {
    expect(describeFsError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }), '/data/kp/1/2')).toContain('нет прав на запись в /data/kp/1/2 (EACCES)');
    expect(describeFsError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }), '/data/kp/1/2')).toContain('chown -R node:node /data');
    expect(describeFsError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '/data/kp/1/template.docx')).toContain('(ENOENT): проверьте KP_FILES_ROOT');
    expect(describeFsError(new Error('boom'), '/x')).toBe('/x: boom');
    expect(asciiFilename('KP-КП-2026-7.pdf')).toBe('KP-KP-2026-7.pdf');
    expect(asciiFilename('Шаблон "КП".docx')).toBe('Shablon _KP_.docx');
  });
});

describe('миграция 005: старые абсолютные пути → относительные', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
  });
  afterAll(() => drop());

  it('template_path, certs_dir, docx_path, pdf_path с «/…/kp/» переписываются от «kp/», прочие не трогаются', async () => {
    const repo = new KpRepo(db);
    await repo.setTemplate(1, { path: '/opt-data/kp/1/template.docx', name: 'kp.docx', md5: 'abc' });
    await repo.saveSettings(1, { certsDir: '/opt-data/kp/1/certs' });
    const id = await repo.createDraft(1, 30021357, { items: [] }, 7);
    await repo.setBuilt(id, { docxPath: '/opt-data/kp/1/30021357/KP-КП-2026-7.docx', pdfPath: '/opt-data/kp/1/30021357/KP-КП-2026-7.pdf', kpNo: 'КП-2026-7' });
    const id2 = await repo.createDraft(1, 1, { items: [] }, 7);
    await repo.setBuilt(id2, { docxPath: 'kp/1/1/KP-КП-2026-8.docx', pdfPath: null, kpNo: 'КП-2026-8' });
    await repo.saveSettings(1, { certsDir: '/srv/certs' });
    await db.query(readFileSync(new URL('../migrations/005_kp_relative_paths.sql', import.meta.url), 'utf8'));
    expect(await repo.getSettings(1)).toMatchObject({ templatePath: 'kp/1/template.docx', certsDir: '/srv/certs' });
    expect(await repo.byId(1, id)).toMatchObject({ docxPath: 'kp/1/30021357/KP-КП-2026-7.docx', pdfPath: 'kp/1/30021357/KP-КП-2026-7.pdf' });
    expect(await repo.byId(1, id2)).toMatchObject({ docxPath: 'kp/1/1/KP-КП-2026-8.docx', pdfPath: null });
    // setBuilt сообщает, что строка обновлена; для несуществующего черновика — false (дефект 2в).
    expect(await repo.setBuilt(999_999, { docxPath: 'x', pdfPath: null, kpNo: 'КП-2026-9' })).toBe(false);
  });
});
