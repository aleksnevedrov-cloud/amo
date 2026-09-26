import { readFileSync } from 'node:fs';
import type { DialogPipeline } from '@ai-door/agent';
import { CatalogImporter, CatalogRepo } from '@ai-door/catalog';
import { AccountsRepo, DialogRepo, JournalRepo, SettingsRepo, widgetSettingsSchema, type Db } from '@ai-door/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../../packages/db/test/setup.ts';
import { runImportFeeds, runIncoming } from '../src/jobs.ts';

let db: Db;
let drop: () => Promise<void>;
const log = { info: () => undefined, warn: () => undefined };
const FEED = new Uint8Array(readFileSync(new URL('../../../evals/fixtures/catalog.yml', import.meta.url)));

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  for (const id of [1, 2]) await new AccountsRepo(db).upsertInstalled({ id, subdomain: `a${id}`, accountDomain: `a${id}.amocrm.ru` });
  await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ catalog: { feedUrl: 'https://rf-dveri.ru/feed.yml' } }));
  await new SettingsRepo(db).save(2, 1, widgetSettingsSchema.parse({ catalog: { feedUrl: 'https://down.example/feed.yml' } }));
});
afterAll(async () => drop());

describe('runImportFeeds', () => {
  it('импортирует по расписанию и пишет ошибки в журнал', async () => {
    const fetchImpl = (async (u: string | URL | Request) =>
      String(u).includes('down.example') ? new Response('', { status: 503 }) : new Response(FEED)) as typeof fetch;
    const d = {
      settings: new SettingsRepo(db),
      catalog: new CatalogRepo(db),
      importer: new CatalogImporter(db, { fetch: fetchImpl, resolve: async () => ['93.158.134.3'] }),
      journal: new JournalRepo(db),
    };
    expect(await runImportFeeds(d, log)).toEqual({ done: [1], failed: [2] });
    expect((await d.journal.list(2))[0]).toMatchObject({ kind: 'error', summary: expect.stringContaining('503') });
    // Второй запуск в тот же день — аккаунт 1 не трогаем, 2 пробуем снова.
    expect(await runImportFeeds(d, log)).toEqual({ done: [], failed: [2] });
    // Через сутки — снова импорт.
    expect((await runImportFeeds(d, log, new Date(Date.now() + 25 * 3600_000))).done).toEqual([1]);
  });
});

describe('runIncoming', () => {
  it('ставит сделку заново, если пришли новые сообщения во время обработки', async () => {
    const dialog = new DialogRepo(db);
    const pipeline = {
      processLead: async () => {
        await dialog.enqueue(1, 50, 'ещё сообщение', null);
        return { status: 'replied', text: 'ok' };
      },
    } as unknown as DialogPipeline;
    const again: unknown[] = [];
    await runIncoming({ accountId: 1, leadId: 50 }, { pipeline, dialog, settings: new SettingsRepo(db) }, async (j, w) => {
      again.push([j, w]);
    });
    expect(again).toEqual([[{ accountId: 1, leadId: 50 }, 8000]]);
  });

  it('без новых сообщений не ставит повторно', async () => {
    const dialog = new DialogRepo(db);
    const pipeline = { processLead: async () => ({ status: 'empty' }) } as unknown as DialogPipeline;
    const again: unknown[] = [];
    await runIncoming({ accountId: 1, leadId: 51 }, { pipeline, dialog, settings: new SettingsRepo(db) }, async () => {
      again.push(1);
    });
    expect(again).toEqual([]);
  });
});

describe('runPollMail', () => {
  it('опрашивает только аккаунты с включённой почтой', async () => {
    const { runPollMail } = await import('../src/jobs.ts');
    const { MailRepo } = await import('@ai-door/mail');
    const { SecretBox } = await import('@ai-door/shared');
    const { randomBytes } = await import('node:crypto');
    await new SettingsRepo(db).save(1, 1, widgetSettingsSchema.parse({ email: { enabled: true, imapHost: 'imap.x.ru', smtpHost: 'smtp.x.ru', username: 'a@x.ru' } }));
    const mail = new MailRepo(db, new SecretBox(randomBytes(32).toString('hex')));
    await mail.setPassword(1, 'p', 1);
    const connected: string[] = [];
    const res = await runPollMail(
      {
        settings: new SettingsRepo(db),
        mail,
        dialog: new DialogRepo(db),
        journal: new JournalRepo(db),
        amo: async () => {
          throw new Error('not used');
        },
        connect: async (cfg) => {
          connected.push(cfg.imapHost);
          return {
            folderState: async () => ({ uidValidity: '1', maxUid: 5 }),
            fetchAfter: async () => [],
            findSentFolder: async () => null,
            append: async () => undefined,
            close: async () => undefined,
          };
        },
        schedule: async () => undefined,
      },
      log,
    );
    expect(connected).toEqual(['imap.x.ru']);
    expect(res).toEqual([expect.objectContaining({ accountId: 1, received: 0 })]);
  });
});

describe('runRefreshOutcomes', () => {
  it('перепроверяет этапы сделок по воронке: вперёд, выиграна, удалена', async () => {
    const { OutcomesRepo } = await import('@ai-door/db');
    const { runRefreshOutcomes } = await import('../src/jobs.ts');
    const { AmoApiClient } = await import('@ai-door/amo');
    const outcomes = new OutcomesRepo(db);
    await outcomes.start(1, 501, 1, 10);
    await outcomes.start(1, 502, 1, 20);
    await outcomes.start(1, 503, 1, 10);
    await outcomes.start(1, 504, 1, 10);
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.pathname === '/api/v4/leads/pipelines') {
        return json({ _embedded: { pipelines: [{ id: 1, name: 'Продажи', _embedded: { statuses: [{ id: 10, name: 'Новая', sort: 10 }, { id: 20, name: 'Замер', sort: 20 }, { id: 142, name: 'Успех', sort: 10000 }] } }] } });
      }
      if (url.pathname === '/api/v4/leads') {
        return json({ _embedded: { leads: [
          { id: 501, status_id: 20, pipeline_id: 1 },
          { id: 502, status_id: 10, pipeline_id: 1 },
          { id: 503, status_id: 142, pipeline_id: 1 },
        ] } });
      }
      return json({});
    }) as typeof fetch;
    const api = new AmoApiClient('a1.amocrm.ru', async () => 'T', f, async () => undefined);
    const r = await runRefreshOutcomes({ outcomes, amo: async () => api }, log, { recheckMs: 0 });
    expect(r).toEqual({ checked: 3, advanced: 2, errors: 0 });
    const { rows } = await db.query('SELECT lead_id, advanced, won, lost FROM dialog_outcomes WHERE account_id = 1 ORDER BY lead_id');
    expect(rows.map((x) => [Number(x.lead_id), x.advanced, x.won, x.lost])).toEqual([
      [501, true, false, false],
      [502, false, false, false],
      [503, true, true, false],
      [504, false, false, true],
    ]);
  });
});
