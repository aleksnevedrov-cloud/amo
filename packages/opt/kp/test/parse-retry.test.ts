// KP-PARSE-RETRY: ответ модели не по схеме — повтор, починка ответа без нового запроса, запрос с текстом ошибки и запасной путь
// по тексту файла; ничего не помогло — «файл не разобран» с причиной и попытками. Ошибка входа IMAP: неверный пароль
// и временный отказ различаются; одна сессия на ящик.
import type { WidgetSettings } from '@core/db';
import type { LlmGateway, RoutedResponse } from '@core/llm';
import { describe, expect, it } from 'vitest';
import { analyzeDraftFile, FileParseError, imapFailureText, isWrongPassword, validateDocument, withMailboxSession, type DraftFileDeps } from '../src/index.ts';

const route = { primary: { provider: 'openai' as const, model: 'gpt-5.5' }, fallback: null };
const settings = { vision: { provider: 'tesseract', maxFilesPerDay: 100, photosToClaude: false }, model: { maxTokens: 4096 } } as unknown as WidgetSettings;
const SPEC = 'Заявка № СИ14792\n1. ДС 1Рл 21х8 Г ПрБ Мд2 — 1 шт\n2. ДМ 1Рл 21х9 Г ПрБ Мд2 — 1 шт\n3. ДМ 1Рп 21х8 О ПрБ Мд3, стекло ЗМ1-2100-800-8-СМ3 — 1 шт';
const position = (name: string, marking: string) => ({ name, marking, width_mm: 800, height_mm: 2100, qty: 1, unit: 'шт', price_rub: null, material: null, color: 'RAL 7035', fireproof: null, note: null });
type Pos = ReturnType<typeof position>;
const doc = (positions: Pos[], extra: Record<string, unknown> = {}) => ({ kind: 'request', title: 'Заявка СИ14792', summary: 'Двери по ГОСТ 475', customer_type: 'b2b', openings: [], positions, requirements: [], questions: [], photo: null, ...extra });
const GOOD = doc([position('Дверь стальная', 'ДС 1Рл 21х8 Г ПрБ Мд2'), position('Дверь', 'ДМ 1Рл 21х9 Г ПрБ Мд2'), position('Дверь остеклённая', 'ДМ 1Рп 21х8 О ПрБ Мд3')]);

/** Ответы шлюза по имени схемы — очередями; запросы запоминаются. */
function gateway(answers: Record<string, (string | undefined)[]>) {
  const asked: { schema: string; text: string }[] = [];
  const llm: LlmGateway = {
    async chat(req, r) {
      const schema = req.outputSchema?.name ?? '';
      asked.push({ schema, text: String(req.messages[0]?.content ?? '') });
      const text = answers[schema]?.shift();
      return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 }, provider: r.primary.provider, model: r.primary.model, assistantMessage: { role: 'assistant', content: text ?? '' }, latencyMs: 1, fallbackUsed: false, requested: r.primary, attempts: [] } as unknown as RoutedResponse;
    },
    providers: async () => ['openai'],
    provider: async () => null,
  };
  return { llm, asked };
}

/** Разбор @core/docs: результаты и ошибки по очереди; сырой ответ последней попытки — lastRaw. */
function deps(results: ({ raw: string } | { ok: unknown })[], llm: LlmGateway) {
  const docs: unknown[] = [];
  let raw: string | null = null;
  const d: DraftFileDeps = {
    docs: {
      async analyze() {
        const next = results.shift();
        if (!next) throw new Error('лишний вызов разбора');
        if ('raw' in next) {
          raw = next.raw;
          throw new Error('Ответ модели не соответствует схеме: Invalid input: expected object, received undefined');
        }
        return { id: 501, kind: 'request', data: next.ok, provider: 'openai', model: 'gpt-5.5', costUsd: 0.01 } as never;
      },
    },
    documents: { add: async (x: unknown) => (docs.push(x), 777), countToday: async () => 0 } as never,
    llm,
    settings,
    route,
    accountId: 1,
    leadId: 30029472,
    userId: 7,
    lastRaw: () => raw,
    resetRaw: () => {
      raw = null;
    },
  };
  return { d, docs };
}
const txt = (text = SPEC) => ({ filename: 'Заявка № СИ14792.txt', mime: 'text/plain', bytes: new TextEncoder().encode(text) });

describe('разбор заявки: повтор и запасной путь (KP-PARSE-RETRY)', () => {
  it('ответ без поля photo — дописывается null, позиции не придумываются; нет positions — ответ не принят', () => {
    const fixed = validateDocument(JSON.stringify({ ...GOOD, photo: undefined, positions: [{ ...GOOD.positions[0], fireproof: undefined }] }));
    expect(fixed).toMatchObject({ ok: true, repaired: ['photo', 'positions[0].fireproof'] });
    expect(validateDocument(JSON.stringify({ ...GOOD, positions: undefined }))).toEqual({ ok: false, error: 'в ответе нет списка позиций (positions)' });
    expect(validateDocument(undefined)).toEqual({ ok: false, error: 'пустой ответ модели' });
    expect(validateDocument('не json')).toEqual({ ok: false, error: 'ответ модели — не JSON' });
    expect(validateDocument(JSON.stringify({ ...GOOD, kind: 'письмо' }))).toMatchObject({ ok: false, error: expect.stringContaining('kind') });
  });

  it('1-я попытка — пустой ответ (undefined), 2-я — по схеме: позиции есть, в попытках виден повтор и сырой ответ', async () => {
    const g = gateway({});
    const { d } = deps([{ raw: '' }, { ok: GOOD }], g.llm);
    const r = await analyzeDraftFile(d, txt());
    expect(r.positions.map((p) => p.marking)).toEqual(['ДС 1Рл 21х8 Г ПрБ Мд2', 'ДМ 1Рл 21х9 Г ПрБ Мд2', 'ДМ 1Рп 21х8 О ПрБ Мд3']);
    expect(r.attempts?.map((a) => [a.n, a.via, a.ok, a.error?.slice(0, 40) ?? null, a.raw])).toEqual([
      [1, 'docs', false, 'Ответ модели не соответствует схеме: Inv', ''],
      [2, 'retry', true, null, null],
    ]);
    expect(r.warnings).toEqual(['разобран со 2-й попытки']);
    expect(g.asked).toHaveLength(0);
  });

  it('сырой ответ без photo (как 21.10, сделка 90141) — починка без нового запроса', async () => {
    const g = gateway({});
    const { d, docs } = deps([{ raw: JSON.stringify({ ...GOOD, photo: undefined }) }], g.llm);
    const r = await analyzeDraftFile(d, txt());
    expect(r.positions).toHaveLength(3);
    expect(r.attempts?.map((a) => [a.via, a.ok, a.repaired ?? null])).toEqual([['docs', false, null], ['repair', true, ['photo']]]);
    expect(docs).toHaveLength(1);
    expect(g.asked).toHaveLength(0);
  });

  it('трижды не по схеме → запасной путь по тексту файла (только позиции); 3-я попытка — с текстом ошибки проверки', async () => {
    const g = gateway({ request_document: ['{"kind":"request"}'], request_positions: [JSON.stringify({ positions: GOOD.positions.map((p) => ({ name: p.name, marking: p.marking, width_mm: p.width_mm, height_mm: p.height_mm, qty: p.qty, note: null })) })] });
    const { d, docs } = deps([{ raw: 'мусор' }, { raw: '{"positions": 5}' }], g.llm);
    const r = await analyzeDraftFile(d, txt());
    expect(r.positions.map((p) => p.marking)).toEqual(['ДС 1Рл 21х8 Г ПрБ Мд2', 'ДМ 1Рл 21х9 Г ПрБ Мд2', 'ДМ 1Рп 21х8 О ПрБ Мд3']);
    expect(r.attempts?.map((a) => [a.n, a.via, a.ok])).toEqual([[1, 'docs', false], [2, 'retry', false], [3, 'text+error', false], [4, 'positions', true]]);
    expect(r.attempts?.[2]?.error).toBe('в ответе нет списка позиций (positions)');
    expect(r.attempts?.[0]?.raw).toBe('мусор');
    expect(r.warnings).toEqual(['разобран запасным путём: только позиции по тексту файла — проверьте характеристики']);
    // Запрос с текстом ошибки проверки и текстом файла (без файла).
    expect(g.asked.map((a) => a.schema)).toEqual(['request_document', 'request_positions']);
    expect(g.asked[0]?.text).toContain('Предыдущий ответ не прошёл проверку: Ответ модели не соответствует схеме');
    expect(g.asked[0]?.text).toContain('ДС 1Рл 21х8 Г ПрБ Мд2');
    expect(docs).toHaveLength(1);
  });

  it('ничего не помогло — FileParseError с причиной и всеми попытками; скан без текста — сразу после повтора', async () => {
    const g = gateway({ request_document: [undefined], request_positions: ['{"positions":"нет"}'] });
    const { d } = deps([{ raw: '' }, { raw: '' }], g.llm);
    const err = await analyzeDraftFile(d, txt()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileParseError);
    expect((err as FileParseError).message).toBe('positions — не список; повторы и разбор по тексту не помогли');
    expect((err as FileParseError).attempts.map((a) => a.via)).toEqual(['docs', 'retry', 'text+error', 'positions']);
    const scan = deps([{ raw: '' }, { raw: '' }], gateway({}).llm);
    const e2 = await analyzeDraftFile(scan.d, txt('')).catch((e: unknown) => e);
    expect((e2 as FileParseError).message).toContain('текста в файле нет (скан или фото)');
  });
});

describe('вход в ящик: неверный пароль и временный отказ (KP-PARSE-RETRY, п. 4)', () => {
  const err = (o: Record<string, unknown>) => Object.assign(new Error(String(o.message ?? 'Command failed')), { authenticationFailed: true, ...o });
  it('«Command failed» без кода — временный отказ, текст сервера — в причине; AUTHENTICATIONFAILED — неверный пароль', () => {
    expect(isWrongPassword(err({}))).toBe(false);
    expect(isWrongPassword(err({ serverResponseCode: 'UNAVAILABLE', responseText: 'LOGIN Temporary error, try again later' }))).toBe(false);
    expect(isWrongPassword(err({ responseText: 'LOGIN Too many simultaneous connections' }))).toBe(false);
    expect(isWrongPassword(err({ serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'LOGIN Invalid user names or password.' }))).toBe(true);
    expect(isWrongPassword(err({ responseText: 'Login failed: authentication failure' }))).toBe(true);
    expect(imapFailureText(err({ serverResponseCode: 'UNAVAILABLE', responseText: 'LOGIN Temporary error' }))).toBe('Command failed: [UNAVAILABLE] LOGIN Temporary error');
    expect(imapFailureText(err({}))).toBe('Command failed');
  });

  it('одна сессия на ящик: вторая начинается после выхода первой, ошибка первой не ломает очередь', async () => {
    const log: string[] = [];
    const slow = (name: string, fail = false) => async () => {
      log.push(`${name}:вход`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`${name}:выход`);
      if (fail) throw new Error('сбой');
      return name;
    };
    const [a, b, c] = await Promise.allSettled([withMailboxSession('box', slow('a', true)), withMailboxSession('box', slow('b')), withMailboxSession('other', slow('c'))]);
    expect([a.status, b.status, c.status]).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(log.filter((x) => !x.startsWith('c'))).toEqual(['a:вход', 'a:выход', 'b:вход', 'b:выход']);
    expect(log.indexOf('c:вход')).toBeLessThan(log.indexOf('a:выход'));
  });
});
