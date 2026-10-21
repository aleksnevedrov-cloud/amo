// KP-PARSE-RETRY (сделка 90141, заявка СИ14792): ответ модели не по схеме — повтор, запасной путь по тексту файла; файл,
// который не разобрался, — в черновике «не разобран» с причиной; сбой входа в ящик не обнуляет черновик — он собирается по
// файлам сделки; «Собрать заново» ящик не читает, если файлы заявки уже в сделке; «Проверить почту заново» — читает.
import { MailAuthError, resetMailAuthPauses } from '@opt/kp';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import type { OptAiProvider } from '@opt/kp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { leadFile, LEAD_ID, setup, widgetToken } from './helpers.ts';

const SPEC = [
  'Заявка № СИ14792 от 21.10.2026. Двери по ГОСТ 475-2016, цвет RAL 7004 / RAL 7035, доводчики.',
  '1. ДС 1Рл 21х8 Г ПрБ Мд2 — 1 шт',
  '2. ДМ 1Рл 21х9 Г ПрБ Мд2 — 1 шт',
  '3. ДМ 1Рп 21х8 О ПрБ Мд3, стекло ЗМ1-2100-800-8-СМ3 — 1 шт',
  '4. ДМ 1Рл 21х9 О ПрБ Мд3 — 1 шт',
  '5. ДМ 1Рп 21х9 О ПрБ Мд3 — 1 шт',
  '6. ДВ 2Рп 21х13 Г ПрБ Мд3 — 1 шт',
].join('\n');
const MARKS = ['ДС 1Рл 21х8 Г ПрБ Мд2', 'ДМ 1Рл 21х9 Г ПрБ Мд2', 'ДМ 1Рп 21х8 О ПрБ Мд3', 'ДМ 1Рл 21х9 О ПрБ Мд3', 'ДМ 1Рп 21х9 О ПрБ Мд3', 'ДВ 2Рп 21х13 Г ПрБ Мд3'];
const size = (m: string) => {
  const r = /(\d{2})х(\d{1,2})/.exec(m);
  return { height_mm: Number(r?.[1]) * 100, width_mm: Number(r?.[2]) * 100 };
};
const positions = MARKS.map((m) => ({ name: m.startsWith('ДС') ? 'Дверь стальная' : m.startsWith('ДВ') ? 'Дверь внутренняя двупольная' : 'Дверь металлическая', marking: m, ...size(m), qty: 1, unit: 'шт', price_rub: null, material: null, color: 'RAL 7035', fireproof: null, note: m.includes('О ') ? 'остеклённая' : null }));
const GOOD = JSON.stringify({ kind: 'request', title: 'Заявка СИ14792', summary: 'Шесть дверей по ГОСТ 475-2016', customer_type: 'b2b', openings: [], positions, requirements: ['ГОСТ 475-2016'], questions: [], photo: null });
// Как 21.10.2026: gpt-5.5 вернул документ без поля photo — @core/docs отверг его «expected object, received undefined».
const LETTER = JSON.stringify({ client: { org: 'ООО Система', fio: '', email: 'snab25@glavsistema.ru', phone: '' }, request_items: [], required_blocks: ['price'], questions: [] });

/** Шлюз модели: ответы по имени схемы — очередями (undefined — пустой ответ); письмо — без позиций. */
function gateway() {
  const queues: Record<string, (string | undefined)[]> = {};
  const asked: string[] = [];
  const llm: LlmGateway = {
    async chat(req, route) {
      const schema = req.outputSchema?.name ?? 'letter';
      asked.push(schema);
      const text = schema === 'letter' ? LETTER : (queues[schema]?.length ? queues[schema].shift() : GOOD);
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: route.primary.provider, model: route.primary.model, assistantMessage: { role: 'assistant', content: text ?? '' }, latencyMs: 1, fallbackUsed: false, requested: route.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  const ai: OptAiProvider = async () => ({ llm, source: 'account', providers: ['openai'], keySources: { openai: 'account' } });
  return { ai, queues, asked };
}

type Draft = { id: number; items: { name: string; size: string; qty: number }[]; needsManager: { request_index: number; reason: string }[]; source: { skipped: { name: string; reason: string; failed?: boolean }[]; files?: { name: string; status: string; positions: number; reason: string | null }[]; mail?: { status: string; error: string | null; retryAt: string | null } } };

describe('заявка не теряется из-за сбоя модели или ящика (KP-PARSE-RETRY)', () => {
  const g = gateway();
  let ctx: Awaited<ReturnType<typeof setup>>;
  let headers: Record<string, string>;
  let imap: 'fail' | 'ok' = 'fail';
  const reads: string[] = [];
  const draft = async () => (await ctx.app.inject({ url: `/widget/v1/kp/draft?leadId=${LEAD_ID}`, headers })).json().draft as Draft;
  const build = async (body: Record<string, unknown> = {}) => {
    await ctx.app.inject({ method: 'POST', url: '/widget/v1/kp/draft', headers, payload: { leadId: LEAD_ID, ...body } });
    return draft();
  };
  const journal = async (kind: string) => (await ctx.app.inject({ url: `/widget/v1/journal?kind=${kind}`, headers })).json().items as { summary: string; details: Record<string, unknown> }[];

  beforeAll(async () => {
    ctx = await setup({
      ai: g.ai,
      mailRead: async (cfg, search) => {
        reads.push(search.from);
        if (imap === 'fail') throw new MailAuthError(`ящик ${cfg.username} временно не пускает (Command failed: [UNAVAILABLE] LOGIN Temporary error) — сервер отказал во входе, хотя пароль не отвергнут (частые входы или лишние соединения); следующая попытка не раньше 13:06 МСК`, new Date('2026-10-21T10:06:00Z'));
        return { mail: null, diag: { criteria: { from: search.from, domain: '', since: '', before: '', subject: null }, folders: [], skippedFolders: [], fallbackWithoutDate: false, errors: [] } };
      },
    });
    headers = { 'x-auth-token': await widgetToken() };
    await ctx.app.inject({ method: 'GET', url: '/oauth/amo/callback', query: { code: 'c', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings', headers, payload: { mail: { smtpHost: 'smtp.yandex.ru', username: 'rf-dveri@yandex.ru' } } });
    await ctx.app.inject({ method: 'PUT', url: '/widget/v1/settings/smtp-password', headers, payload: { password: 'app-password' } });
    ctx.amo.mail = { id: 5, created_at: 1_760_000_000, params: { income: true, subject: 'СИ14792 срочно', text: 'Добрый день! Заявка во вложении.', from: 'snab25@glavsistema.ru' } };
    // Файлы уже в сделке (загружены первой сборкой): карточка предприятия и заявка.
    leadFile(ctx.amo, 'f-card', 'Карточка ООО Система Сбербанк .pdf', new TextEncoder().encode('ИНН 7700000000 КПП 770001001 р/с 40702810000000000000'), 'application/pdf');
    leadFile(ctx.amo, 'f-spec', 'Заявка № СИ14792.txt', new TextEncoder().encode(SPEC), 'text/plain');
  });
  beforeEach(() => resetMailAuthPauses());
  afterAll(() => ctx.close());

  it('IMAP падает — черновик собран по файлам сделки: 6 позиций, карточка — реквизиты; в окне — «ящик не прочитан» со временем повтора', async () => {
    // 1-я попытка — пустой ответ (дважды: @core/docs сам повторяет пустой ответ с большим лимитом), 2-я — по схеме.
    g.queues.document = [undefined, undefined, GOOD];
    const d = await build();
    expect(reads).toHaveLength(1);
    expect(d.items.map((l) => l.size)).toEqual(['800×2100 мм', '900×2100 мм', '800×2100 мм', '900×2100 мм', '900×2100 мм', '1300×2100 мм']);
    expect(d.source.mail).toMatchObject({ status: 'error', retryAt: '2026-10-21T10:06:00.000Z' });
    expect(d.needsManager).toContainEqual({ request_index: -1, reason: expect.stringMatching(/^ящик не прочитан: ящик rf-dveri@yandex\.ru временно не пускает \(Command failed: \[UNAVAILABLE\].*следующая попытка не раньше 13:06 МСК — черновик собран по файлам и письму из сделки$/) });
    expect(d.source.files).toEqual([
      { name: 'Заявка № СИ14792.txt', status: 'parsed', positions: 6, reason: 'разобран со 2-й попытки' },
      { name: 'Карточка ООО Система Сбербанк .pdf', status: 'skipped', positions: 0, reason: 'реквизиты предприятия — не заявка' },
    ]);
    // Журнал: повторная попытка видна, с текстом ошибки и сырым ответом (пустым).
    const j = (await journal('kp_draft'))[0]!;
    expect(j.summary).toMatch(/^Черновик КП: позиций 6, документов 1, пропущено файлов 1; файлы: Заявка № СИ14792\.txt — позиций 6/);
    const files = j.details.files as { name: string; attempts?: { n: number; via: string; ok: boolean; error: string | null; raw: string | null }[] }[];
    expect(files[0]?.attempts?.map((a) => [a.n, a.via, a.ok, a.raw])).toEqual([[1, 'docs', false, ''], [2, 'retry', true, null]]);
    expect(files[0]?.attempts?.[0]?.error).toContain('слишком объёмный');
  });

  it('«Собрать заново»: файлы заявки в сделке — ящик не читаем; ответ без photo (как 21.10) чинится без нового запроса', async () => {
    g.queues.document = [JSON.stringify({ ...JSON.parse(GOOD), photo: undefined })];
    const before = g.asked.length;
    const d = await build();
    expect(reads).toHaveLength(1);
    expect(d.items).toHaveLength(6);
    expect(d.source.mail).toMatchObject({ status: 'skipped', error: 'в сделке уже есть файлы заявки (1) — ящик не читали; новое письмо — кнопка «Проверить почту заново»' });
    expect(d.source.files?.[0]).toEqual({ name: 'Заявка № СИ14792.txt', status: 'parsed', positions: 6, reason: 'ответ модели дополнен пустыми полями: photo' });
    expect(g.asked.slice(before).filter((s) => s !== 'letter')).toEqual(['document']);
    expect((await journal('mail_fetch'))[0]?.summary).toContain('Ящик не читали: в сделке уже есть файлы заявки');
  });

  it('трижды не по схеме — запасной путь по тексту; не помог и он — файл «не разобран» с причиной, прежний черновик с позициями сохранён', async () => {
    g.queues.document = ['{"positions": 5}', '{"positions": 5}'];
    g.queues.request_document = ['{"kind":"request"}'];
    g.queues.request_positions = [JSON.stringify({ positions: positions.map((p) => ({ name: p.name, marking: p.marking, width_mm: p.width_mm, height_mm: p.height_mm, qty: p.qty, note: p.note })) })];
    const d = await build();
    expect(d.items).toHaveLength(6);
    expect(d.source.files?.[0]).toMatchObject({ status: 'parsed', positions: 6, reason: 'разобран запасным путём: только позиции по тексту файла — проверьте характеристики' });
    // Всё мимо: «не разобран» с причиной; пересборка без позиций прежний черновик не заменяет (пометка о пересборке).
    g.queues.document = ['мусор', 'мусор'];
    g.queues.request_document = ['мусор'];
    g.queues.request_positions = ['мусор'];
    await build();
    const j = (await journal('kp_draft'))[0];
    const err = (await journal('kp_error'))[0]!;
    expect(err.summary).toMatch(/пересборка не дала ни одной позиции/);
    expect(j?.summary).toMatch(/позиций 6/);
    const kept = await draft();
    expect(kept.needsManager.some((n) => /^пересборка .* без позиций/.test(n.reason))).toBe(true);
  });

  it('файл не разобран в новой сделке без прежнего черновика — «не разобран» с причиной в source.skipped (failed) и в сводке', async () => {
    // Прежние черновики сделки отменяем — сборка как первая.
    for (const row of (await ctx.deps.db.query("SELECT id FROM kp_drafts WHERE lead_id = $1 AND status = 'draft'", [LEAD_ID])).rows) await ctx.deps.kp.setStatus(Number(row.id), 'cancelled');
    imap = 'ok';
    g.queues.document = ['мусор', 'мусор'];
    g.queues.request_document = ['мусор'];
    g.queues.request_positions = ['мусор'];
    const d = await build();
    expect(d.items).toHaveLength(0);
    const failed = d.source.skipped.find((s) => s.failed);
    expect(failed).toEqual({ name: 'Заявка № СИ14792.txt', reason: 'ответ модели — не JSON; повторы и разбор по тексту не помогли', failed: true });
    expect(d.source.files?.find((f) => f.status === 'failed')).toMatchObject({ name: 'Заявка № СИ14792.txt', reason: 'ответ модели — не JSON; повторы и разбор по тексту не помогли' });
    const j = (await journal('kp_draft'))[0]!;
    expect(j.summary).toContain('не разобрано 1 («Заявка № СИ14792.txt»: ответ модели — не JSON; повторы и разбор по тексту не помогли)');
    expect((j.details.failedFiles as { attempts: { via: string; raw: string | null }[] }[])[0]?.attempts.map((a) => [a.via, a.raw])).toEqual([['docs', 'мусор'], ['retry', 'мусор'], ['text+error', 'мусор'], ['positions', 'мусор']]);
  });

  it('«Проверить почту заново» — ящик читается, даже если файлы заявки в сделке', async () => {
    const n = reads.length;
    await build({ checkMail: true });
    expect(reads).toHaveLength(n + 1);
    await build();
    expect(reads).toHaveLength(n + 1);
  });
});
