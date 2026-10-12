import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsRepo, type Db } from '@core/db';
import { defaultOptSettings, optSettingsSchema, OptSettingsRepo, resolveOptRoute, toWidgetSettings } from '../src/settings.ts';
import { freshOptDb } from './setup.ts';

describe('настройки опта', () => {
  it('значения по умолчанию: OpenAI gpt-5.5 с резервом gpt-5.1, SMTP 465, шаблон темы', () => {
    const s = defaultOptSettings();
    expect(s.model).toMatchObject({ provider: 'openai', model: 'gpt-5.5', fallbackModel: 'gpt-5.1', fallbackProvider: null });
    expect(s.mail).toMatchObject({ smtpPort: 465, smtpSecure: true, subject: 'Коммерческое предложение {kpNo}' });
    expect(resolveOptRoute(s)).toEqual({ primary: { provider: 'openai', model: 'gpt-5.5' }, fallback: { provider: 'openai', model: 'gpt-5.1' } });
    expect(resolveOptRoute(optSettingsSchema.parse({ model: { fallbackModel: 'gpt-5.5' } })).fallback).toBeNull();
  });

  it('лишние ключи отклоняются (schema strict), переходник для @core/docs несёт модель и разбор файлов', () => {
    expect(optSettingsSchema.safeParse({ mail: { pop3Host: 'x' } }).success).toBe(false);
    // IMAP для чтения заявки по кнопке: значения Яндекса по умолчанию (вариант А).
    expect(optSettingsSchema.parse({}).mail).toMatchObject({ imapHost: 'imap.yandex.ru', imapPort: 993, imapSecure: true });
    const w = toWidgetSettings(optSettingsSchema.parse({ vision: { provider: 'yandex' }, billing: { usdRubRate: 95 } }));
    expect(w.model).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
    expect(w.vision).toMatchObject({ provider: 'yandex', autoParse: false, noteInLead: false });
    expect(w.billing.usdRubRate).toBe(95);
  });
});

describe('OptSettingsRepo', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await freshOptDb());
    await new AccountsRepo(db).upsertInstalled({ id: 1, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
  });
  afterAll(() => drop());

  it('пусто → значения по умолчанию с версией 0; сохранение поднимает версию', async () => {
    const repo = new OptSettingsRepo(db);
    expect(await repo.get(1)).toEqual({ settings: defaultOptSettings(), version: 0 });
    const next = optSettingsSchema.parse({ mail: { smtpHost: 'smtp.yandex.ru', username: 'sales@rf-dveri.ru' } });
    expect(await repo.save(1, 7, next)).toEqual({ version: 1 });
    expect(await repo.save(1, 7, next)).toEqual({ version: 2 });
    const got = await repo.get(1);
    expect(got.version).toBe(2);
    expect(got.settings.mail).toMatchObject({ smtpHost: 'smtp.yandex.ru', username: 'sales@rf-dveri.ru' });
  });
});
