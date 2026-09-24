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
