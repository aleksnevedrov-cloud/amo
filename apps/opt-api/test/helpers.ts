import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmGateway, RoutedRequest, RoutedResponse } from '@core/llm';
import { loadEnv } from '@core/shared';
import type { Embedder, KbIndexJob, UrlFetcher } from '@opt/kb';
import { runDraftJob, runResearchJob, type KpMail, type KpMailSender, type OptAiProvider, type ResearchJob, type SmtpConfig } from '@opt/kp';
import { SignJWT } from 'jose';
import { freshKbDb } from '../../../packages/opt/kb/test/setup.ts';
import { freshOptDb } from '../../../packages/opt/kp/test/setup.ts';
import { buildApp } from '../src/app.ts';
import { createDeps, type Deps, type DraftJobState } from '../src/deps.ts';

export const CLIENT_ID = '8b4f5e3a-2c1d-4e5f-9a8b-7c6d5e4f3a2b';
export const CLIENT_SECRET = 'test-client-secret-0123456789abcdef';
export const PUBLIC_URL = 'https://opt.example.ru';
export const ACCOUNT_ID = 31337;
export const LEAD_ID = 89835;

export interface AmoMock {
  calls: { url: string; method: string; body: unknown; auth: string | null }[];
  /** Письмо-примечание в сделке; null — писем нет. */
  mail: Record<string, unknown> | null;
  files: unknown[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** amoCRM и загрузка файлов в сделку: ровно то, что опт читает из карточки и кладёт обратно. */
export function amoFetch(mock: AmoMock): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    mock.calls.push({ url, method, body: typeof raw === 'string' ? JSON.parse(raw) : raw ? 'bytes' : null, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/oauth2/access_token')) return json(200, { token_type: 'Bearer', expires_in: 86400, access_token: 'ACCESS', refresh_token: 'REFRESH' });
    if (url.endsWith('/api/v4/account?with=drive_url')) return json(200, { id: ACCOUNT_ID, drive_url: 'https://drive-b.amocrm.ru' });
    if (url.endsWith('/api/v4/account')) return json(200, { id: ACCOUNT_ID, name: 'РУС-ДВЕРИ', subdomain: 'aleksnevedrov' });
    if (url.includes(`/api/v4/leads/${LEAD_ID}/notes?`) && url.includes('note_type%5D%5B%5D=common')) return new Response(null, { status: 204 });
    if (url.includes(`/api/v4/leads/${LEAD_ID}/notes?`) && url.includes('note_type][]=common')) return new Response(null, { status: 204 });
    if (url.includes(`/api/v4/leads/${LEAD_ID}/notes?`)) return mock.mail ? json(200, { _embedded: { notes: [mock.mail] } }) : new Response(null, { status: 204 });
    if (url.endsWith(`/api/v4/leads/${LEAD_ID}/notes`) && method === 'POST') return json(200, { _embedded: { notes: [{ id: 1 }] } });
    if (url.includes(`/api/v4/leads/${LEAD_ID}/files`) && method === 'GET') return mock.files.length ? json(200, { _embedded: { files: mock.files } }) : new Response(null, { status: 204 });
    if (url.endsWith(`/api/v4/leads/${LEAD_ID}/files`) && method === 'PUT') return json(200, {});
    if (url.includes(`/api/v4/leads/${LEAD_ID}`)) return json(200, { id: LEAD_ID, name: 'Двери для офиса', price: 0, status_id: 10, pipeline_id: 1, responsible_user_id: 3, created_at: 0, custom_fields_values: null, _embedded: { contacts: [{ id: 77, is_main: true }] } });
    if (url.endsWith('/api/v4/contacts/77')) return json(200, { id: 77, name: 'Иванов Иван', custom_fields_values: [{ field_id: 1, field_code: 'EMAIL', values: [{ value: 'ivanov@romashka.ru' }] }] });
    if (url === 'https://drive-b.amocrm.ru/v1.0/sessions' && method === 'POST') return json(200, { upload_url: 'https://upload.amocrm.ru/part/1', max_part_size: 10_000_000 });
    if (url.startsWith('https://upload.amocrm.ru/')) return json(200, { uuid: 'file-uuid-1' });
    return json(404, {});
  }) as typeof fetch;
}

/** Шлюз LLM с заранее заданным ответом; запросы запоминаются. */
export function fakeGateway(text: string) {
  const requests: RoutedRequest[] = [];
  const llm: LlmGateway = {
    async chat(req, route) {
      requests.push(req);
      const res: RoutedResponse = {
        text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 },
        provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [],
      };
      return res;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, requests };
}

export interface SentMail {
  cfg: SmtpConfig;
  mail: KpMail;
}

export async function setup(opts: { ai?: OptAiProvider; failSend?: string; embedder?: Embedder | null; fetchUrl?: UrlFetcher } = {}) {
  const { db, drop } = await freshOptDb();
  // База знаний — своя схема с миграциями @opt/kb (расширение vector в тестовой БД: образ pgvector/pgvector:pg16).
  const kb = await freshKbDb();
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PUBLIC_URL,
    DATABASE_URL: 'postgres://unused:unused@localhost/unused',
    REDIS_URL: 'redis://localhost:6379',
    AMO_CLIENT_ID: CLIENT_ID,
    AMO_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  });
  const amo: AmoMock = { calls: [], mail: null, files: [] };
  const sent: SentMail[] = [];
  const mailer: KpMailSender = {
    async send(cfg, mail) {
      if (opts.failSend) throw new Error(opts.failSend);
      sent.push({ cfg, mail });
    },
  };
  // Очередь в тестах выполняет задание сразу, в том же процессе: состояние — как после работы воркера.
  const jobs: { state: DraftJobState }[] = [];
  const researchStates = new Map<string, DraftJobState>();
  let core: Deps | null = null;
  const deps: Deps = createDeps(env, {
    db,
    fetch: amoFetch(amo),
    redis: { ping: async () => 'PONG' },
    alerter: { alert: async () => undefined },
    ...(opts.ai ? { ai: opts.ai } : {}),
    filesRoot: mkdtempSync(join(tmpdir(), 'opt-kp-')),
    kbDb: kb.db,
    kbFilesRoot: mkdtempSync(join(tmpdir(), 'opt-kb-')),
    embedderFor: async () => opts.embedder ?? null,
    // Ссылки базы знаний: без сети — подмена скачивания; по умолчанию любой адрес «недоступен».
    kbFetchUrl: opts.fetchUrl ?? (async (url) => { throw new Error(`HTTP 503 (тест: ${url})`); }),
    // Ящик по IMAP в тестах не читаем: письмо «не найдено», сборка идёт по карточке.
    mailRead: async () => ({ mail: null, diag: { criteria: { from: '', domain: '', since: '', before: '', subject: null }, folders: [], skippedFolders: [], fallbackWithoutDate: false, errors: [] } }),
    mailer,
    queue: {
      async enqueue(job) {
        try {
          await runDraftJob(core!, job);
          jobs.push({ state: null });
        } catch (err) {
          jobs.push({ state: { state: 'failed', error: (err as Error).message } });
        }
      },
      async state() {
        return jobs.at(-1)?.state ?? null;
      },
      close: async () => undefined,
    },
    // Индексация базы знаний — сразу, как воркер kb-index; ошибки разбора оседают в источнике (status error), задание завершено.
    kbQueue: {
      async enqueue(job: KbIndexJob) {
        // Страницы раздела (обход) индексируются тут же, рекурсивно — как в воркере, по одной.
        await core!.kb.index(job, { enqueue: (j) => this.enqueue(j) });
      },
      async states() {
        return {};
      },
      close: async () => undefined,
    },
    // Поиск цен тоже выполняется сразу; состояние по позициям — как после воркера (failed с текстом, иначе завершено).
    researchQueue: {
      async enqueue(list: ResearchJob[]) {
        for (const j of list) {
          try {
            await runResearchJob(core!, j);
            researchStates.set(`${j.draftId}:${j.requestIndex}`, null);
          } catch (err) {
            researchStates.set(`${j.draftId}:${j.requestIndex}`, { state: 'failed', error: (err as Error).message });
          }
        }
      },
      async states(_accountId, draftId, idx) {
        return Object.fromEntries(idx.map((i) => [i, researchStates.get(`${draftId}:${i}`) ?? null]));
      },
      close: async () => undefined,
    },
  });
  core = deps;
  const app = await buildApp(deps);
  return { app, deps, amo, sent, close: async () => (await app.close(), await drop(), await kb.drop()) };
}

export function widgetToken(claims: Record<string, unknown> = {}, key = CLIENT_SECRET) {
  return new SignJWT({ subdomain: 'aleksnevedrov', account_id: ACCOUNT_ID, user_id: 7, client_uuid: CLIENT_ID, is_admin: true, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomBytes(8).toString('hex'))
    .setIssuer('https://aleksnevedrov.amocrm.ru')
    .setAudience(PUBLIC_URL)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(key));
}

type SurveyQ = { key: string; type: string; blocking: boolean; answer: unknown; options: { id: string; price?: number | null }[]; fields?: { name: string }[]; requestIndexes: number[] };
type SurveyAnswer = { option?: string | null; price?: number | null; fields?: Record<string, string> };

/**
 * KP-AGENT-V2: ответить на открытые блокирующие вопросы опросника, чтобы собрать документ. По умолчанию: самовывоз, срок цены
 * «30 календарных дней», «без цены» для «введите цену» и «выбор модели», медиана для цены из интернета, «как посчитано» для
 * нестандарта, «исключить» для аналога; неполная позиция — текущее количество. Свой ответ по типу — в over.
 */
export async function answerSurvey(app: Awaited<ReturnType<typeof setup>>['app'], headers: Record<string, string>, leadId: number, over: Record<string, SurveyAnswer | ((q: SurveyQ) => SurveyAnswer)> = {}) {
  for (let round = 0; round < 6; round += 1) {
    const d = (await app.inject({ method: 'GET', url: `/widget/v1/kp/draft?leadId=${leadId}`, headers })).json().draft as { id: number; survey: SurveyQ[]; items: { request_index: number; qty: number }[] };
    const open = d.survey.filter((q) => q.blocking && !q.answer && q.type !== 'component_door');
    if (!open.length) return d;
    for (const q of open) {
      const o = over[q.type];
      const a: SurveyAnswer = typeof o === 'function' ? o(q) : o
        ?? (q.type === 'delivery' ? { option: 'pickup' }
          : q.type === 'price_validity' ? { fields: { text: '30 календарных дней' } }
          : q.type === 'enter_price' || q.type === 'model_choice' ? { option: 'no_price' }
          : q.type === 'web_price' ? { option: 'median' }
          : q.type === 'nonstandard' ? (q.options[0] ? { option: q.options[0].id } : { price: 1000 })
          : q.type === 'analog' ? { option: 'exclude' }
          : { fields: Object.fromEntries((q.fields ?? []).map((f) => [f.name, f.name === 'qty' ? String(d.items.find((l) => l.request_index === q.requestIndexes[0])?.qty ?? 1) : '—'])) });
      const r = await app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d.id}/answer`, headers, payload: { key: q.key, ...a } });
      if (r.statusCode !== 200) throw new Error(`ответ на «${q.key}»: ${r.statusCode} ${r.body}`);
    }
  }
  throw new Error('опросник не закрылся за 6 кругов');
}
