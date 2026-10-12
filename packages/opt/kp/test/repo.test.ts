import { AccountsRepo, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KpRepo } from '../src/repo.ts';
import { freshOptDb } from './setup.ts';

describe('KpRepo на БД опта (миграции с нуля)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
  });
  afterAll(() => drop());

  it('настройки по умолчанию, сохранение констант и шаблона', async () => {
    const repo = new KpRepo(db);
    const s = await repo.getSettings(1);
    expect(s.numbering).toEqual({ prefix: 'КП', year: null, counter: 0 });
    expect(s.templatePath).toBeNull();
    await repo.saveSettings(1, { constants: { vatRate: 22, sellerName: 'ООО "РУС-ДВЕРИ"' }, numbering: { prefix: 'КП', counter: 5 } });
    await repo.setTemplate(1, { path: '/data/kp/1/template.docx', name: 'kp.docx', md5: 'abc' });
    const got = await repo.getSettings(1);
    expect(got.constants).toMatchObject({ vatRate: 22, sellerName: 'ООО "РУС-ДВЕРИ"' });
    expect(got).toMatchObject({ templatePath: '/data/kp/1/template.docx', templateName: 'kp.docx', templateMd5: 'abc' });
    expect(got.numbering.counter).toBe(5);
  });

  it('черновик: создание, последний по сделке, номер при сборке, статусы', async () => {
    const repo = new KpRepo(db);
    const id = await repo.createDraft(1, 89835, { items: [] }, 7);
    expect((await repo.latestByLead(1, 89835))?.id).toBe(id);
    expect(await repo.latestByLead(1, 1)).toBeNull();
    // Год в нумерации ещё не задан — счётчик начинается заново, дальше растёт.
    const no = await repo.nextNumber(1, new Date(2026, 9, 12));
    expect(no).toBe('КП-2026-1');
    expect(await repo.nextNumber(1, new Date(2026, 9, 13))).toBe('КП-2026-2');
    await repo.setBuilt(id, { docxPath: '/d.docx', pdfPath: null, kpNo: no });
    expect(await repo.byId(1, id)).toMatchObject({ status: 'built', kpNo: 'КП-2026-1', docxPath: '/d.docx', pdfPath: null });
    await repo.setStatus(id, 'sent');
    expect((await repo.byId(1, id))?.status).toBe('sent');
    await repo.setPayload(id, { items: [{ name: 'x' }] });
    expect((await repo.byId(1, id))?.payload).toEqual({ items: [{ name: 'x' }] });
  });
});
