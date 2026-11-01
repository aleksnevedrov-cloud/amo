// RFD-AI-AGENT-WA-FILES: фоновый разбор файлов Wazzup в обе стороны — исходящий PDF менеджера разбирается тем же кодом,
// что вложения писем, и хранится один раз; аудио / видео не разбираются (отметка); входящий, уже разобранный агентом,
// повторно не берётся; ошибка скачивания → пометка в сообщении и журнале без падения; повторный проход ничего не находит.
import { AccountsRepo, JournalRepo, SettingsRepo, WazzupRepo, widgetSettingsSchema, type Db } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../../core/db/test/setup.ts';
import { checkFileLimit } from '../../../core/docs/src/service.ts';
import { formatWazzupFiles, runWazzupFiles, wazzupFileName, wazzupMimeOf, type WazzupFileAnalyzer } from '../src/wazzup-files.ts';

const ACC = 1;
const KP_TEXT = '[Документ «КП_Иванов.pdf»] Коммерческое предложение № 1187 от 22.10.2026. Дверь «Классика 3» эмаль белая 800×2000 — 3 шт. по 19 680 ₽; фурнитура Morelli — 3 компл. по 4 200 ₽; монтаж 3 × 5 500 ₽. Итого 88 140 ₽. Срок изготовления 25 рабочих дней, предоплата 70 %.';
const log = { info: () => undefined, warn: () => undefined };

describe('файлы Wazzup: фоновое задание (wazzup-files)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let wazzup: WazzupRepo;
  let journal: JournalRepo;
  let settings: SettingsRepo;
  const analyzed: { filename: string; mime: string; bytes: number; leadId: number | null; source: string }[] = [];
  const downloaded: string[] = [];
  const documents: WazzupFileAnalyzer = {
    async analyze(input) {
      analyzed.push({ filename: input.filename, mime: input.mime, bytes: input.bytes.byteLength, leadId: input.leadId, source: input.source });
      return { id: analyzed.length, kind: 'quote', text: KP_TEXT, costUsd: 0.03, model: 'test-docs' };
    },
  };
  const download = async (url: string) => {
    downloaded.push(url);
    if (url.includes('broken')) throw Object.assign(new Error('файл недоступен: HTTP 404'), { status: 404 });
    return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mime: 'application/pdf', filename: url.includes('noname') ? 'Счёт 77.pdf' : null };
  };
  let seq = 0;
  const msg = (messageId: string, direction: 'in' | 'out', contentUri: string, contentType: string, extra: Partial<Parameters<WazzupRepo['upsert']>[1]> = {}) =>
    wazzup.upsert(ACC, { messageId, channelId: 'ch1', chatId: '79099500381', chatType: 'whatsapp', phone: '79099500381', direction, author: direction === 'in' ? 'client' : 'manager', text: direction === 'in' ? '[document]' : 'Отправляю КП', status: null, isSystem: false, sentAt: new Date(Date.UTC(2026, 9, 22, 7, 45, ++seq)), source: 'webhook', raw: { type: contentType }, contentUri, contentType, ...extra });
  // «Сейчас» для деления на новые / старые — рядом с датами сообщений теста (22.10): все файлы ниже — новые.
  const deps = () => ({ wazzup, settings, journal, documents, download, now: () => new Date('2026-10-22T08:00:00Z') });

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
    settings = new SettingsRepo(db);
    await settings.save(ACC, 1, widgetSettingsSchema.parse({}));
    wazzup = new WazzupRepo(db);
    journal = new JournalRepo(db);
  });
  afterAll(() => drop());

  it('исходящий PDF менеджера → текст один раз в wazzup_messages, журнал document; имя — из вебхука или content-disposition', async () => {
    await msg('m-kp', 'out', 'https://store.wazzup24.com/files/КП_Иванов.pdf', 'document', { raw: { type: 'document', fileName: 'КП_Иванов.pdf' } });
    await msg('m-bill', 'out', 'https://store.wazzup24.com/files/noname', 'document');
    await msg('m-photo', 'in', 'https://store.wazzup24.com/files/IMG_1.jpg', 'image');
    const r = await runWazzupFiles(deps(), log);
    expect(r).toMatchObject({ accounts: 1, picked: 3, done: 3, skipped: 0, failed: 0 });
    // MIME ответа хранилища точнее типа Wazzup; DocumentService уточнит по содержимому.
    expect(new Set(analyzed.map((a) => `${a.filename}|${a.mime}|${a.source}`))).toEqual(new Set(['КП_Иванов.pdf|application/pdf|chat', 'Счёт 77.pdf|application/pdf|chat', 'IMG_1.jpg|application/pdf|chat']));
    const files = await wazzup.filesByPhones(ACC, ['79099500381'], new Date('2026-10-01T00:00:00Z'));
    expect(files.map((f) => [f.messageId, f.direction, f.file.name, f.file.status, f.file.text === KP_TEXT])).toEqual([
      ['m-kp', 'out', 'КП_Иванов.pdf', 'done', true],
      ['m-bill', 'out', 'Счёт 77.pdf', 'done', true],
      ['m-photo', 'in', 'IMG_1.jpg', 'done', true],
    ]);
    const log1 = await journal.list(ACC, { kind: 'document' });
    expect(log1.map((e) => e.summary)).toContain('Разобран файл Wazzup «КП_Иванов.pdf» от менеджера (quote)');
    expect(log1.find((e) => e.summary.includes('КП_Иванов'))?.costUsd).toBeCloseTo(0.03);
    // Строки контекста агента (п. 2 ТЗ): менеджер отправил файл — с текстом КП.
    const lines = formatWazzupFiles(files);
    expect(lines[0]).toMatch(/^\[22\.10, 10:45\] Менеджер отправил файл «КП_Иванов\.pdf»: \[Документ «КП_Иванов\.pdf»\] Коммерческое предложение № 1187 .* Итого 88 140 ₽\./);
    expect(lines[2]).toMatch(/^\[22\.10, 10:45\] Клиент прислал файл «IMG_1\.jpg»: /);
  });

  it('повторного разбора нет: второй проход ничего не берёт', async () => {
    const before = analyzed.length;
    expect(await runWazzupFiles(deps(), log)).toMatchObject({ picked: 0, done: 0 });
    expect(analyzed.length).toBe(before);
    expect(await wazzup.filesPending(ACC)).toEqual([]);
  });

  it('аудио и видео не разбираются — отметка; входящий, уже разобранный агентом при получении, пропускается без скачивания', async () => {
    await msg('m-voice', 'in', 'https://store.wazzup24.com/files/voice.ogg', 'audio');
    await msg('m-video', 'out', 'https://store.wazzup24.com/files/demo.mp4', 'video');
    await msg('m-old', 'in', 'https://store.wazzup24.com/files/IMG_old.jpg', 'image');
    const old = (await wazzup.incomingContent(ACC, ['79099500381'], new Date(0), new Date())).find((i) => i.contentUri.includes('IMG_old'));
    await wazzup.markConsumed(ACC, [old?.id ?? 0]);
    const n = downloaded.length;
    const r = await runWazzupFiles(deps(), log);
    expect(r).toMatchObject({ picked: 3, done: 0, skipped: 3, failed: 0 });
    expect(downloaded.length).toBe(n);
    const files = await wazzup.filesByPhones(ACC, ['79099500381'], new Date('2026-10-01T00:00:00Z'));
    const by = Object.fromEntries(files.map((f) => [f.messageId, f.file]));
    expect(by['m-voice']).toMatchObject({ name: 'voice.ogg', text: null, status: 'skipped', error: 'аудио' });
    expect(by['m-video']).toMatchObject({ name: 'demo.mp4', text: null, status: 'skipped', error: 'видео' });
    expect(by['m-old']).toMatchObject({ status: 'skipped', error: 'разобран агентом при получении' });
    expect(formatWazzupFiles([{ direction: 'in', sentAt: new Date('2026-10-22T07:45:00Z'), file: by['m-voice']! }])).toEqual(['[22.10, 10:45] Клиент прислал файл «voice.ogg» (аудио)']);
  });

  it('ошибка скачивания → failed с текстом ошибки и запись в журнале, задание не падает; дневной лимит разбора оставляет файл в очереди', async () => {
    await msg('m-broken', 'out', 'https://store.wazzup24.com/files/broken/КП_2.pdf', 'document');
    const r = await runWazzupFiles(deps(), log);
    expect(r).toMatchObject({ picked: 1, failed: 1, done: 0 });
    const files = await wazzup.filesByPhones(ACC, ['79099500381'], new Date('2026-10-01T00:00:00Z'));
    expect(files.find((f) => f.messageId === 'm-broken')?.file).toMatchObject({ name: 'КП_2.pdf', status: 'failed', error: 'скачивание: файл недоступен: HTTP 404' });
    const errors = await journal.list(ACC, { kind: 'error' });
    expect(errors.map((e) => e.summary)).toContain('Файл Wazzup «КП_2.pdf» (менеджер, исходящий) не скачан: файл недоступен: HTTP 404');
    expect(formatWazzupFiles([{ direction: 'out', sentAt: new Date('2026-10-22T07:45:00Z'), file: files.find((f) => f.messageId === 'm-broken')!.file }])).toEqual(['[22.10, 10:45] Менеджер отправил файл «КП_2.pdf» (разобрать не удалось)']);
    // Лимит разбора на день (DocumentError stage 'limit') — файл остаётся pending до следующего прохода.
    await msg('m-limit', 'out', 'https://store.wazzup24.com/files/КП_3.pdf', 'document');
    const limited: WazzupFileAnalyzer = { analyze: async () => { throw Object.assign(new Error('дневной лимит разбора файлов исчерпан'), { stage: 'limit' }); } };
    expect(await runWazzupFiles({ ...deps(), documents: limited }, log)).toMatchObject({ picked: 1, deferred: 1, skipped: 0, failed: 0 });
    expect((await wazzup.filesPending(ACC)).map((p) => [p.messageId, p.fileStatus])).toEqual([['m-limit', 'deferred']]);
    expect((await wazzup.filesByPhones(ACC, ['79099500381'], new Date('2026-10-01T00:00:00Z'))).find((f) => f.messageId === 'm-limit')?.file).toMatchObject({ status: 'deferred', error: 'отложено по дневному лимиту: дневной лимит разбора файлов исчерпан' });
    expect(await runWazzupFiles(deps(), log)).toMatchObject({ picked: 1, done: 1, byPriority: { new: 0, backlog: 0, deferred: 1 } });
  });

  it('разбор вложений выключен (vision.autoParse) или DocumentService недоступен → отметка без скачивания', async () => {
    await msg('m-off', 'out', 'https://store.wazzup24.com/files/КП_4.pdf', 'document');
    const n = downloaded.length;
    expect(await runWazzupFiles({ ...deps(), documents: null }, log)).toMatchObject({ picked: 1, skipped: 1 });
    expect(downloaded.length).toBe(n);
    expect((await wazzup.filesByPhones(ACC, ['79099500381'], new Date('2026-10-01T00:00:00Z'))).find((f) => f.messageId === 'm-off')?.file).toMatchObject({ status: 'skipped', error: 'разбор вложений выключен' });
  });

  it('приоритет (RFD-AI-AGENT-FILES-PRIORITY): лимит 3, очередь старых 10 — новый файл разобран первым, догрузка не больше доли; упёршийся в лимит новый — отложен и разобран на следующий день', async () => {
    const vision = { maxFilesPerDay: 3, backlogShare: 0.5 };
    const usage = { total: 0, new: 0, backlog: 0, deferred: 0 };
    const calls: { filename: string; priority: string }[] = [];
    const limited: WazzupFileAnalyzer = {
      async analyze(input) {
        const err = checkFileLimit(usage, vision, input.priority);
        if (err) throw err;
        usage.total++;
        usage[input.priority]++;
        calls.push({ filename: input.filename, priority: input.priority });
        return { id: calls.length, kind: 'quote', text: `текст ${input.filename}`, costUsd: 0.01, model: 'test-docs' };
      },
    };
    const now = new Date();
    for (let i = 1; i <= 10; i++) await msg(`old-${i}`, 'in', `https://store.wazzup24.com/files/old-${i}.pdf`, 'document', { sentAt: new Date(now.getTime() - (10 + i) * 86_400_000) });
    await msg('new-1', 'in', 'https://store.wazzup24.com/files/new-1.pdf', 'document', { sentAt: new Date(now.getTime() - 3_600_000) });
    const r1 = await runWazzupFiles({ ...deps(), documents: limited, now: () => now }, log);
    expect(r1).toMatchObject({ picked: 11, done: 2, deferred: 0, backlogWait: 9, failed: 0, byPriority: { new: 1, backlog: 1, deferred: 0 } });
    expect(calls.find((c) => c.filename === 'new-1.pdf')?.priority).toBe('new');
    expect(calls.filter((c) => c.priority === 'backlog')).toHaveLength(1);
    // Ещё три новых за день: лимит 3 на новые — два разобраны, третий отложен; старые ждут (доля дня выбрана).
    for (let i = 2; i <= 4; i++) await msg(`new-${i}`, 'in', `https://store.wazzup24.com/files/new-${i}.pdf`, 'document', { sentAt: new Date(now.getTime() - i * 60_000) });
    const r2 = await runWazzupFiles({ ...deps(), documents: limited, now: () => now }, log);
    expect(r2).toMatchObject({ done: 2, deferred: 1, backlogWait: 9, byPriority: { new: 2, backlog: 0, deferred: 0 } });
    const pending = await wazzup.filesPending(ACC, 50);
    expect(pending.filter((p) => p.fileStatus === 'deferred')).toHaveLength(1);
    expect(pending.filter((p) => p.fileStatus === null)).toHaveLength(9);
    expect(pending[0]?.fileStatus).toBe('deferred'); // отложенный — первым в очереди
    const skippedLog = await journal.list(ACC, { kind: 'skipped' });
    expect(skippedLog.some((e) => /^Файл Wazzup «new-\d\.pdf» \(клиент\) отложен по дневному лимиту — разберётся автоматически$/.test(e.summary))).toBe(true);
    // Следующие сутки (лимит обнулился): отложенный разобран первым, догрузка — снова в пределах доли.
    Object.assign(usage, { total: 0, new: 0, backlog: 0, deferred: 0 });
    const r3 = await runWazzupFiles({ ...deps(), documents: limited, now: () => now }, log);
    expect(r3).toMatchObject({ done: 2, deferred: 0, backlogWait: 8, byPriority: { new: 0, backlog: 1, deferred: 1 } });
    expect(calls.at(-2)?.priority === 'deferred' || calls.at(-1)?.priority === 'deferred').toBe(true);
    expect((await journal.list(ACC, { kind: 'document' })).some((e) => e.summary.includes('(quote, отложенный)'))).toBe(true);
    expect((await wazzup.filesPending(ACC, 50)).every((p) => p.fileStatus === null)).toBe(true);
  });

  it('имя и MIME файла по вебхуку, заголовку и ссылке', () => {
    expect(wazzupFileName({ contentUri: 'https://store.wazzup24.com/a/b/%D0%9A%D0%9F.pdf', contentType: 'document', raw: null })).toBe('КП.pdf');
    expect(wazzupFileName({ contentUri: 'https://store.wazzup24.com/a/b/x', contentType: 'document', raw: { fileName: 'Счёт.pdf' } })).toBe('Счёт.pdf');
    expect(wazzupFileName({ contentUri: 'https://store.wazzup24.com/a/b/x', contentType: 'document', raw: null }, 'из-заголовка.docx')).toBe('из-заголовка.docx');
    expect(wazzupFileName({ contentUri: 'https://store.wazzup24.com', contentType: 'image', raw: null })).toBe('image');
    expect([wazzupMimeOf('image', null), wazzupMimeOf('document', 'application/pdf; charset=binary'), wazzupMimeOf('document', 'application/octet-stream'), wazzupMimeOf('audio', null)]).toEqual(['image/jpeg', 'application/pdf', 'application/octet-stream', 'audio/ogg']);
  });
});
