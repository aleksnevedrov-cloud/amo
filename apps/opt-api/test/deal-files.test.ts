// RFD-AI-AGENT-OPT-DEAL-FILES: файлы сделки «90287» (30038356) — список amo отдаёт только id и file_uuid, карточка файла в
// Files API на drive_url; без карточки — «пропущено» с причиной. Разбор файлов — через замоканную модель.
import type { LlmGateway, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_ID, leadFileCard, LEAD_ID, setup, widgetToken } from './helpers.ts';

/** Документ по имени файла: счёт / смета — kind estimate с двумя позициями (как у живого счёта № 126), остальное — заявка с одной дверью. */
const DOC = (title: string) => {
  const estimate = /сч[её]т|смета/i.test(title);
  const pos = (name: string) => ({ name, marking: null, width_mm: 900, height_mm: 2100, qty: 1, unit: 'шт', price_rub: estimate ? 16_400 : null, material: null, color: null, fireproof: null, note: null });
  return JSON.stringify({ kind: estimate ? 'estimate' : 'request', title: title.replace(/\.[^.]+$/, ''), summary: title, customer_type: 'b2b', openings: [], positions: estimate ? [pos('Межкомнатная дверь ДПГ (RAL 1013) 800×2000'), pos('Межкомнатная дверь ДПГ (RAL 1013) 900×2000')] : [pos(`Дверь из «${title}»`)], requirements: [], questions: [], photo: null });
};
const LETTER = JSON.stringify({ client: { org: 'ООО Заказчик', fio: '', email: 'client@example.ru', phone: '' }, request_items: [], required_blocks: ['price'], questions: [] });

/** Шлюз: письмо — без позиций; документ — одна дверь с названием файла (чтобы видеть, какие файлы разобраны). */
function gateway() {
  const docs: string[] = [];
  const llm: LlmGateway = {
    async chat(req, route) {
      const schema = req.outputSchema?.name ?? 'letter';
      const text = req.messages.map((msg) => (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : '')).join('\n');
      // Имя файла @core/docs ставит в запрос сам («Имя файла: …»); строка внутри текста может уйти под чистку персональных данных.
      const m = /Имя файла: ([^\n]+)/.exec(text);
      const title = m?.[1]?.trim() ?? 'документ';
      if (schema !== 'letter') docs.push(title);
      const out = schema === 'letter' ? LETTER : DOC(title);
      return { text: out, toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: out }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, docs };
}

type Draft = { id: number; items: { name: string }[]; needsManager: { request_index: number; reason: string }[]; survey: { key: string; type: string; blocking: boolean; text: string; options: { id: string; label: string }[] }[]; source: { attachments: string[]; skipped: { name: string; reason: string }[]; files?: { name: string; status: string; positions: number; reason: string | null }[]; yadisk?: { url: string; where: string; name: string; type: string; taken: number; skipped: number; error: string | null }[] } };

describe('файлы сделки опта (RFD-AI-AGENT-OPT-DEAL-FILES, часть 0)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  const draft = async () => (await ctx.app.inject({ url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  const build = async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    return draft();
  };
  const txt = (title: string) => new TextEncoder().encode(`${title}\nЗаявка на двери: дверной блок 900×2100, 1 шт.`);

  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Заявка', text: 'Файлы в сделке', from: 'client@example.ru' } };
  });
  afterAll(() => ctx.close());

  it('ответ /leads/{id}/files только с file_uuid и id (реальный формат): 3 файла с именами из Files API разобраны; файл без карточки — «карточка файла не получена: HTTP 404»', async () => {
    leadFileCard(ctx.amo, '2a5408d7-f411-4919-88cc-b714b9f6f2ac', 'Двери внутренние Данилково (4).txt', txt('Двери внутренние Данилково (4).txt'), 'text/plain');
    leadFileCard(ctx.amo, '5fb0943d-f045-4edf-897d-a87cc3118b12', 'Двери наружные Данилково (4).txt', txt('Двери наружные Данилково (4).txt'), 'text/plain');
    leadFileCard(ctx.amo, '7c1e0000-0000-0000-0000-000000000003', 'Счет покупателю № 126 от 3 ноября 2026 г.txt', txt('Счет покупателю № 126 от 3 ноября 2026 г.txt'), 'text/plain');
    leadFileCard(ctx.amo, 'dead-beef-0000-0000-0000-000000000004', null, new Uint8Array(), 'application/pdf');
    const d = await build();
    expect(d.source.attachments).toEqual(['Двери внутренние Данилково (4).txt', 'Двери наружные Данилково (4).txt', 'Счет покупателю № 126 от 3 ноября 2026 г.txt']);
    expect(d.source.skipped).toEqual([{ name: 'файл dead-beef-0000-0000-0000-000000000004', reason: 'карточка файла не получена: HTTP 404' }]);
    // Счёт без признаков нашей компании — смета стороннего продавца: позиции берутся (две, как в фикстуре).
    expect(d.source.files?.map((f) => [f.name, f.status, f.positions])).toEqual([
      ['Двери внутренние Данилково (4).txt', 'parsed', 1],
      ['Двери наружные Данилково (4).txt', 'parsed', 1],
      ['Счет покупателю № 126 от 3 ноября 2026 г.txt', 'parsed', 2],
      ['файл dead-beef-0000-0000-0000-000000000004', 'skipped', 0],
    ]);
    expect(d.items.map((i) => i.name)).toEqual(['Дверь из «Двери внутренние Данилково (4).txt»', 'Дверь из «Двери наружные Данилково (4).txt»', 'Межкомнатная дверь ДПГ (RAL 1013) 800×2000', 'Межкомнатная дверь ДПГ (RAL 1013) 900×2000']);
    // Карточки запрошены в Files API на drive_url, а не на домене аккаунта.
    const urls = ctx.amo.calls.map((c) => c.url);
    expect(urls.filter((u) => u.startsWith('https://drive-b.amocrm.ru/v1.0/files/'))).toHaveLength(4);
    expect(urls.some((u) => u.includes('aleksnevedrov.amocrm.ru/api/v4/files/dead-beef'))).toBe(true);
  }, 30_000);
});

describe('ссылки Яндекс Диска при сборке черновика опта (RFD-AI-AGENT-OPT-DEAL-FILES, часть Б)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  const FOLDER = 'https://yadi.sk/d/Pj7JaZqDEJJA1Q';
  const draft = async () => (await ctx.app.inject({ url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  const build = async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    return draft();
  };
  const txt = (title: string) => new TextEncoder().encode(`${title}\nЗаявка на двери: дверной блок 900×2100, 1 шт.`);
  const file = (name: string, path: string, bytes: Uint8Array) => ({ type: 'file', name, path, size: bytes.byteLength, mime_type: 'text/plain' });
  /** Фикстура cloud-api: папка по ссылке с файлами первого уровня, отдельные файлы по ссылкам yadi.sk/i. */
  const disk = (folderFiles: string[], single: string[] = []) => {
    const resources: Record<string, unknown> = {};
    const files: Record<string, { bytes: Uint8Array; mime: string }> = {};
    const items = folderFiles.map((n) => {
      const b = txt(n);
      files[`${FOLDER}/${n}`] = { bytes: b, mime: 'text/plain' };
      return file(n, `/${n}`, b);
    });
    resources[FOLDER] = { type: 'dir', name: 'Данилково', path: '/', _embedded: { items } };
    for (const [i, n] of single.entries()) {
      const b = txt(n);
      const key = `https://yadi.sk/i/single${i + 1}`;
      resources[key] = { type: 'file', name: n, path: `/${n}`, size: b.byteLength, mime_type: 'text/plain' };
      files[key] = { bytes: b, mime: 'text/plain' };
    }
    ctx.amo.yadisk = { resources, files };
  };
  const reset = () => {
    ctx.amo.files = [];
    ctx.amo.cards = {};
    ctx.amo.blobs = {};
    ctx.amo.leadFields = [];
    ctx.amo.notes = [];
    ctx.amo.contactNotes = [];
    ctx.amo.yadisk = { resources: {}, files: {} };
    ctx.amo.calls.length = 0;
  };

  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Заявка', text: 'Файлы на Диске', from: 'client@example.ru' } };
  });
  afterAll(() => ctx.close());

  it('поле сделки «Яндекс.Диск - Ссылка на папку» (id поля не хардкодится) → файлы папки разобраны; в сводке строка «Яндекс Диск: папка …, взято N»', async () => {
    reset();
    ctx.amo.leadFields = [{ field_id: 987_001, field_name: 'Яндекс.Диск - Ссылка на папку', field_code: null, values: [{ value: FOLDER }] }];
    disk(['Двери внутренние Данилково (4).txt', 'Двери наружные Данилково (4).txt']);
    const d = await build();
    expect(d.source.attachments).toEqual(['Двери внутренние Данилково (4).txt', 'Двери наружные Данилково (4).txt']);
    expect(d.items.map((i) => i.name)).toEqual(['Дверь из «Двери внутренние Данилково (4).txt»', 'Дверь из «Двери наружные Данилково (4).txt»']);
    expect(d.source.yadisk).toEqual([{ url: FOLDER, where: 'поле «Яндекс.Диск - Ссылка на папку»', name: 'Данилково', type: 'dir', taken: 2, skipped: 0, error: null }]);
    expect(d.source.skipped).toEqual([]);
    // Б7: на Диск ходили только за метаданными и файлами; в «Файлы» сделки ничего не загружено.
    expect(ctx.amo.calls.some((c) => c.url.includes('/api/v4/leads/') && c.method === 'PUT')).toBe(false);
    expect(ctx.amo.calls.filter((c) => c.url.startsWith('https://cloud-api.yandex.net/')).map((c) => new URL(c.url).pathname)).toEqual(['/v1/disk/public/resources', '/v1/disk/public/resources/download', '/v1/disk/public/resources/download']);
  }, 30_000);

  it('примечание робота с 3 ссылками yadi.sk → 3 файла разобраны; примечание контакта тоже читается; другое облако — пометка', async () => {
    reset();
    disk([], ['Ведомость 1.txt', 'Ведомость 2.txt', 'Ведомость 3.txt']);
    ctx.amo.notes = [{ id: 1, note_type: 'common', created_at: 1_760_000_100, created_by: 0, params: { text: 'Загружен файл: https://yadi.sk/i/single1\nЗагружен файл: https://yadi.sk/i/single2 и https://cloud.mail.ru/public/abc/def' } }];
    ctx.amo.contactNotes = [{ id: 2, note_type: 'common', created_at: 1_760_000_200, created_by: 0, params: { text: 'Ещё файл https://yadi.sk/i/single3.' } }];
    const d = await build();
    expect(d.source.attachments).toEqual(['Ведомость 1.txt', 'Ведомость 2.txt', 'Ведомость 3.txt']);
    expect(d.items).toHaveLength(3);
    expect(d.source.yadisk?.map((l) => [l.name, l.type, l.taken, l.where])).toEqual([
      ['cloud.mail.ru', 'unsupported', 0, 'примечание сделки'],
      ['Ведомость 1.txt', 'file', 1, 'примечание сделки'],
      ['Ведомость 2.txt', 'file', 1, 'примечание сделки'],
      ['Ведомость 3.txt', 'file', 1, 'примечание контакта'],
    ]);
    expect(d.source.skipped).toEqual([{ name: 'cloud.mail.ru', reason: 'ссылка на облако не поддерживается: cloud.mail.ru' }]);
  }, 30_000);

  it('те же файлы в «Файлах» сделки и в папке Диска — разбор по одному разу (Б6), дубли в «пропущено»', async () => {
    reset();
    const names = ['Двери внутренние Данилково (4).txt', 'Двери наружные Данилково (4).txt', 'Счет покупателю № 126.txt'];
    for (const [i, n] of names.entries()) leadFileCard(ctx.amo, `uuid-${i}`, n, txt(n), 'text/plain');
    disk(names);
    ctx.amo.leadFields = [{ field_id: 987_001, field_name: 'Яндекс.Диск - Ссылка на папку', values: [{ value: FOLDER }] }];
    const d = await build();
    expect(d.source.attachments).toEqual([...names, ...names]);
    // Три файла сделки (счёт — две позиции), файлы Диска с теми же байтами — повторы (DEAL-FILES-2: по SHA-256 после скачивания).
    expect(d.items).toHaveLength(4);
    expect(d.source.yadisk).toEqual([{ url: FOLDER, where: 'поле «Яндекс.Диск - Ссылка на папку»', name: 'Данилково', type: 'dir', taken: 3, skipped: 0, error: null }]);
    expect(d.source.skipped.map((x) => x.reason)).toEqual(names.map((n) => `повтор файла «${n}» из «Файлов» сделки`));
    expect(ctx.amo.calls.filter((c) => c.url.startsWith('https://downloader.disk.yandex.ru/'))).toHaveLength(3);
  }, 30_000);

  it('404 от Диска → строка в «пропущено» с текстом Диска, черновик собран по остальному', async () => {
    reset();
    leadFileCard(ctx.amo, 'uuid-ok', 'Заявка.txt', txt('Заявка.txt'), 'text/plain');
    ctx.amo.leadFields = [{ field_id: 987_001, field_name: 'Яндекс.Диск - Ссылка на папку', values: [{ value: 'https://yadi.sk/d/gone' }] }];
    const d = await build();
    expect(d.items.map((i) => i.name)).toEqual(['Дверь из «Заявка.txt»']);
    expect(d.source.yadisk).toEqual([{ url: 'https://yadi.sk/d/gone', where: 'поле «Яндекс.Диск - Ссылка на папку»', name: 'https://yadi.sk/d/gone', type: 'error', taken: 0, skipped: 0, error: 'Диск: Не удалось найти запрошенный ресурс. (HTTP 404)' }]);
    expect(d.source.skipped).toEqual([{ name: 'https://yadi.sk/d/gone', reason: 'Диск: Не удалось найти запрошенный ресурс. (HTTP 404)' }]);
  }, 30_000);

  it('лимит 10 файлов на черновик — общий с файлами сделки: 2 файла сделки + 12 на Диске → разобрано 10, остальные в «пропущено»', async () => {
    reset();
    leadFileCard(ctx.amo, 'uuid-a', 'Заявка A.txt', txt('Заявка A.txt'), 'text/plain');
    leadFileCard(ctx.amo, 'uuid-b', 'Заявка B.txt', txt('Заявка B.txt'), 'text/plain');
    disk(Array.from({ length: 12 }, (_, i) => `Лист ${i + 1}.txt`));
    ctx.amo.leadFields = [{ field_id: 987_001, field_name: 'Яндекс.Диск - Ссылка на папку', values: [{ value: FOLDER }] }];
    const d = await build();
    expect(d.items).toHaveLength(10);
    expect(d.source.skipped.map((x) => [x.name, x.reason])).toEqual([['Лист 9.txt', 'больше 10 файлов за раз не разбираем'], ['Лист 10.txt', 'больше 10 файлов за раз не разбираем'], ['Лист 11.txt', 'больше 10 файлов за раз не разбираем'], ['Лист 12.txt', 'больше 10 файлов за раз не разбираем']]);
    expect(d.source.yadisk?.[0]).toMatchObject({ name: 'Данилково', taken: 12 });
  }, 60_000);
});

describe('дубли файлов и наш документ (RFD-AI-AGENT-OPT-DEAL-FILES-2, 2.1–2.2)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  const FOLDER = 'https://yadi.sk/d/Pj7JaZqDEJJA1Q';
  const draft = async () => (await ctx.app.inject({ url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  const build = async () => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID } });
    return draft();
  };
  const txt = (title: string, body = 'Заявка на двери: дверной блок 900×2100, 1 шт.') => new TextEncoder().encode(`${title}\n${body}`);
  const diskFolder = (files: { name: string; bytes: Uint8Array }[]) => {
    const resources: Record<string, unknown> = { [FOLDER]: { type: 'dir', name: '30038356', path: '/', _embedded: { items: files.map((f) => ({ type: 'file', name: f.name, path: `/${f.name}`, size: f.bytes.byteLength, mime_type: 'text/plain' })) } } };
    const blobs: Record<string, { bytes: Uint8Array; mime: string }> = {};
    for (const f of files) blobs[`${FOLDER}/${f.name}`] = { bytes: f.bytes, mime: 'text/plain' };
    ctx.amo.yadisk = { resources, files: blobs };
    ctx.amo.leadFields = [{ field_id: 987_001, field_name: 'Яндекс.Диск - Ссылка на папку', values: [{ value: FOLDER }] }];
  };
  const reset = () => {
    ctx.amo.files = [];
    ctx.amo.cards = {};
    ctx.amo.blobs = {};
    ctx.amo.leadFields = [];
    ctx.amo.notes = [];
    ctx.amo.contactNotes = [];
    ctx.amo.yadisk = { resources: {}, files: {} };
    ctx.amo.calls.length = 0;
  };
  const downloads = () => ctx.amo.calls.filter((c) => c.url.startsWith('https://downloader.disk.yandex.ru/')).length;

  beforeAll(async () => {
    ctx = await setup({ ai: g.ai });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'Заявка', text: 'Файлы в сделке и на Диске', from: 'client@example.ru' } };
  });
  afterAll(() => ctx.close());

  // Первым в наборе: пересборка без позиций не заменяет прежний черновик с позициями (KP-REBUILD-MAIL).
  it('в сделке только наш счёт — вопрос в опроснике «взять его позиции?»; «Да» — позиции взяты', async () => {
    reset();
    leadFileCard(ctx.amo, 'u-inv', 'Счет покупателю № 126.txt', txt('Счет покупателю № 126.txt', 'Поставщик: ООО "РУС-ДВЕРИ", ИНН 7700000001. Покупатель: ООО Заказчик.'), 'text/plain');
    const d = await build();
    expect(d.items).toEqual([]);
    const q = d.survey.find((x) => x.type === 'own_document');
    expect(q).toMatchObject({ key: 'own_document', blocking: true, text: 'В сделке только наш счёт «Счет покупателю № 126» — взять его позиции?', options: [{ id: 'yes', label: 'Да, взять позиции' }, { id: 'no', label: 'Нет, оставить черновик без позиций' }] });
    expect(d.needsManager.map((n) => n.reason)).toContain('в сделке только наш документ («Счет покупателю № 126») — взять его позиции? Вопрос в опроснике');
    const r = await ctx.app.inject({ method: 'POST', url: `/widget/v1/kp/draft/${d.id}/answer`, headers, payload: { key: 'own_document', option: 'yes' } });
    expect(r.statusCode).toBe(200);
    const after = r.json().draft as Draft;
    expect(after.items.map((i) => i.name)).toEqual(['Межкомнатная дверь ДПГ (RAL 1013) 800×2000', 'Межкомнатная дверь ДПГ (RAL 1013) 900×2000']);
    expect(after.survey.find((x) => x.type === 'own_document')).toBeUndefined();
    expect(after.needsManager.map((n) => n.reason)).toContain('позиции взяты из нашего документа по решению менеджера («Счет покупателю № 126»)');
  }, 30_000);

  it('файл сделки «Двери внутренние Данилково (4)» (amo без расширения) и файл Диска «… (4).pdf» с теми же байтами — разобран один раз, второй «повтор»; одинаковые байты под другим именем — тоже повтор (SHA-256)', async () => {
    reset();
    const inner = txt('Двери внутренние Данилково (4)');
    const outer = txt('Двери наружные Данилково (4)');
    leadFileCard(ctx.amo, 'u-inner', 'Двери внутренние Данилково (4)', inner, 'text/plain');
    leadFileCard(ctx.amo, 'u-outer', 'Двери наружные Данилково (4)', outer, 'text/plain');
    diskFolder([{ name: 'Двери внутренние Данилково (4).pdf', bytes: inner }, { name: 'Копия наружных.pdf', bytes: outer }]);
    const d = await build();
    expect(d.items.map((i) => i.name)).toEqual(['Дверь из «Двери внутренние Данилково (4)»', 'Дверь из «Двери наружные Данилково (4)»']);
    expect(d.source.skipped).toEqual([
      { name: 'Двери внутренние Данилково (4).pdf', reason: 'повтор файла «Двери внутренние Данилково (4)» из «Файлов» сделки' },
      { name: 'Копия наружных.pdf', reason: 'повтор файла «Двери наружные Данилково (4)» из «Файлов» сделки' },
    ]);
    // Оба файла Диска скачаны (по имени не отсеиваем — те же имя и размер могут скрывать другие байты), хэши совпали.
    expect(downloads()).toBe(2);
    expect(d.source.yadisk?.[0]).toMatchObject({ name: '30038356', taken: 2, skipped: 0 });
  }, 30_000);

  it('одинаковое имя и размер, разные байты — оба разобраны', async () => {
    reset();
    const a = txt('Заявка.txt', 'Заявка на двери: дверной блок 900×2100, 1 шт.');
    const b = txt('Заявка.txt', 'Заявка на двери: дверной блок 800×2100, 1 шт.');
    expect(a.byteLength).toBe(b.byteLength);
    leadFileCard(ctx.amo, 'u-a', 'Заявка.txt', a, 'text/plain');
    diskFolder([{ name: 'Заявка.txt', bytes: b }]);
    const d = await build();
    expect(d.source.skipped).toEqual([]);
    expect(d.source.files?.filter((f) => f.status === 'parsed')).toHaveLength(2);
    expect(downloads()).toBe(1);
  }, 30_000);

  it('наш счёт (продавец ООО «РУС-ДВЕРИ» или ИНН из настроек КП) позиций не даёт — «наш документ»; смета другого поставщика — позиции с пометкой', async () => {
    reset();
    await ctx.deps.kp.saveSettings(ACCOUNT_ID, { constants: { sellerName: 'ООО «РУС-ДВЕРИ»', sellerRequisites: 'ИНН 7700000001 КПП 770001001' } });
    leadFileCard(ctx.amo, 'u-req', 'Заявка клиента.txt', txt('Заявка клиента.txt'), 'text/plain');
    leadFileCard(ctx.amo, 'u-inv', 'Счет покупателю № 126 от 3 ноября 2026 г.txt', txt('Счет покупателю № 126 от 3 ноября 2026 г.txt', 'Поставщик: ООО "РУС-ДВЕРИ", ИНН 7700000001, КПП 770001001. Покупатель: ООО Заказчик.'), 'text/plain');
    leadFileCard(ctx.amo, 'u-inv2', 'Счет 127.txt', txt('Счет 127.txt', 'Поставщик: Общество с ограниченной ответственностью Р.Д., ИНН 7700000001. Покупатель: ООО Заказчик.'), 'text/plain');
    leadFileCard(ctx.amo, 'u-est', 'Смета ООО Партнёр.txt', txt('Смета ООО Партнёр.txt', 'Поставщик: ООО Партнёр, ИНН 5000000000. Двери межкомнатные.'), 'text/plain');
    const d = await build();
    expect(d.items.map((i) => i.name)).toEqual(['Дверь из «Заявка клиента.txt»', 'Межкомнатная дверь ДПГ (RAL 1013) 800×2000', 'Межкомнатная дверь ДПГ (RAL 1013) 900×2000']);
    expect(d.source.files?.map((f) => [f.name, f.status, f.positions, f.reason])).toEqual([
      ['Заявка клиента.txt', 'parsed', 1, null],
      ['Счет покупателю № 126 от 3 ноября 2026 г.txt', 'skipped', 0, 'наш документ (продавец ООО «РУС-ДВЕРИ»), позиции не берутся'],
      ['Счет 127.txt', 'skipped', 0, 'наш документ (продавец ООО «РУС-ДВЕРИ»), позиции не берутся'],
      ['Смета ООО Партнёр.txt', 'parsed', 2, 'из сметы другого поставщика: Смета ООО Партнёр'],
    ]);
    expect(d.needsManager.some((n) => n.reason === 'из сметы другого поставщика: Смета ООО Партнёр — позиции взяты из неё, проверьте')).toBe(true);
    expect(d.survey.find((q) => q.type === 'own_document')).toBeUndefined();
  }, 30_000);
});
