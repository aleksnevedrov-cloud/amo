// Помощники тестов звонков: поддельный fetch amoCRM + ВАТС и зависимости модуля на тестовой БД.
import { AccountsRepo, JournalRepo, SettingsRepo, type Db } from '@core/db';
import { CallsRepo, DaySummariesRepo, type CallsDeps } from '../src/index.ts';

const T0 = Math.floor(Date.parse('2026-10-21T12:05:51Z') / 1000);

export interface Fake {
  contactNotes: unknown[];
  leadNotes: unknown[];
  records: Record<string, () => Response>;
  calls: string[];
}
export const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeAmoFetch(f: Fake): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    f.calls.push(url);
    if (url.includes('/api/v4/contacts/notes?')) return url.includes('page=1') && f.contactNotes.length ? json(200, { _embedded: { notes: f.contactNotes } }) : new Response(null, { status: 204 });
    if (url.includes('/api/v4/leads/notes?')) return url.includes('page=1') && f.leadNotes.length ? json(200, { _embedded: { notes: f.leadNotes } }) : new Response(null, { status: 204 });
    if (url.endsWith('/api/v4/contacts/501?with=leads')) return json(200, { id: 501, _embedded: { leads: [{ id: 90141 }, { id: 80000 }, { id: 70000 }, { id: 60000 }] } });
    if (url.endsWith('/api/v4/contacts/502?with=leads')) return json(200, { id: 502, _embedded: { leads: [] } });
    if (url.includes('/api/v4/leads?filter')) {
      return json(200, {
        _embedded: {
          leads: [
            { id: 90141, status_id: 28643029, pipeline_id: 1873498, updated_at: T0 - 100, closed_at: null },
            { id: 80000, status_id: 28643029, pipeline_id: 1873498, updated_at: T0 - 50_000, closed_at: null },
            { id: 70000, status_id: 142, pipeline_id: 1873498, updated_at: T0 + 1000, closed_at: T0 + 1000 },
            { id: 60000, status_id: 11, pipeline_id: 2, updated_at: T0 + 5000, closed_at: null },
          ],
        },
      });
    }
    const rec = f.records[url];
    if (rec) return rec();
    return json(404, { error: `нет ответа для ${url}` });
  }) as typeof fetch;
}

export function depsOf(db: Db, fetchImpl: typeof fetch, filesRoot: string, extra: Partial<CallsDeps> = {}): CallsDeps {
  const settings = new SettingsRepo(db);
  return {
    calls: new CallsRepo(db),
    days: new DaySummariesRepo(db),
    journal: new JournalRepo(db),
    accounts: new AccountsRepo(db),
    tokenService: { getAccessToken: async () => 'TOKEN' },
    fetch: fetchImpl,
    filesRoot,
    keys: { speechkit: 'y', openai: 'o' },
    alerter: { alert: async () => undefined },
    settingsFor: async (accountId) => (await settings.get(accountId)).settings,
    llmFor: async () => null,
    accountIds: () => settings.listAccountIds(),
    ...extra,
  };
}

