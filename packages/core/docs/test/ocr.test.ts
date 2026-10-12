import { describe, expect, it } from 'vitest';
import { layoutPage, OcrError, parseRecognitionStream, pdfPageCount, YandexVision, type TextAnnotation } from '../src/index.ts';

const box = (x: number, y: number, w = 100, h = 20) => ({ vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });

describe('layoutPage', () => {
  it('строки с одной высотой объединяются в строку таблицы через табуляцию', () => {
    const a: TextAnnotation = {
      blocks: [
        { lines: [{ boundingBox: box(300, 100), text: '838' }, { boundingBox: box(10, 102), text: 'Спальня' }] },
        { lines: [{ boundingBox: box(500, 99), text: '2050' }, { boundingBox: box(10, 140), text: 'Кухня' }, { boundingBox: box(300, 141), text: '805' }] },
      ],
    };
    expect(layoutPage(a).text).toBe('Спальня\t838\t2050\nКухня\t805');
  });

  it('таблицы из разметки восстанавливаются по индексам ячеек', () => {
    const a: TextAnnotation = {
      tables: [{ rowCount: 2, columnCount: 3, cells: [{ rowIndex: 0, columnIndex: 0, text: 'Проём' }, { rowIndex: 0, columnIndex: 1, text: 'Ш' }, { rowIndex: 1, columnIndex: 0, text: '1' }, { rowIndex: 1, columnIndex: 1, text: '838' }] }],
      fullText: 'ignored',
    };
    const p = layoutPage(a);
    expect(p.tables).toEqual(['Проём\tШ\n1\t838']);
    expect(p.text).toBe('Проём\tШ\n1\t838');
  });

  it('без блоков — fullText', () => {
    expect(layoutPage({ fullText: ' просто текст ' }).text).toBe('просто текст');
  });
});

describe('parseRecognitionStream', () => {
  it('JSON по строке, массив или один объект', () => {
    const a = JSON.stringify({ result: { textAnnotation: { fullText: 'a' } } });
    const b = JSON.stringify({ textAnnotation: { fullText: 'b' } });
    expect(parseRecognitionStream(`${a}\n${b}\n`).map((x) => x.fullText)).toEqual(['a', 'b']);
    expect(parseRecognitionStream(`[${a},${b}]`).map((x) => x.fullText)).toEqual(['a', 'b']);
    expect(parseRecognitionStream(a).map((x) => x.fullText)).toEqual(['a']);
    expect(parseRecognitionStream('')).toEqual([]);
  });
});

describe('YandexVision', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('фото: синхронный вызов с моделью handwritten и ключом', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ result: { textAnnotation: { blocks: [{ lines: [{ boundingBox: box(0, 0), text: 'Спальня 838' }] }] } } }));
    }) as typeof fetch;
    const r = await new YandexVision('KEY', 'FOLDER', f).recognize(png, 'image/png');
    expect(r.text).toBe('Спальня 838');
    expect(calls[0]!.url).toBe('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText');
    expect(calls[0]!.body).toMatchObject({ mimeType: 'image/png', model: 'handwritten', languageCodes: ['ru', 'en'] });
    expect(calls[0]!.headers.get('authorization')).toBe('Api-Key KEY');
    expect(calls[0]!.headers.get('x-folder-id')).toBe('FOLDER');
  });

  it('многостраничный PDF: async + опрос операции + getRecognition', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 << /Type /Pages /Kids [] /Count 3 >>');
    const urls: string[] = [];
    let polls = 0;
    const f = (async (u: string | URL | Request) => {
      const url = String(u);
      urls.push(url);
      if (url.endsWith('recognizeTextAsync')) return new Response(JSON.stringify({ id: 'op1', done: false }));
      if (url.includes('/operations/')) return new Response(JSON.stringify({ done: ++polls >= 2 }));
      return new Response(['{"result":{"textAnnotation":{"fullText":"стр 1"}}}', '{"result":{"textAnnotation":{"fullText":"стр 2"}}}'].join('\n'));
    }) as typeof fetch;
    const r = await new YandexVision('K', 'F', f, async () => undefined).recognize(pdf, 'application/pdf');
    expect(r.pages).toHaveLength(2);
    expect(r.text).toContain('--- страница 2 ---\nстр 2');
    expect(urls.filter((u) => u.includes('/operations/op1'))).toHaveLength(2);
    expect(urls.at(-1)).toContain('getRecognition?operationId=op1');
  });

  it('ошибки API и неподдерживаемый формат', async () => {
    const f = (async () => new Response(JSON.stringify({ message: 'quota' }), { status: 429 })) as typeof fetch;
    await expect(new YandexVision('K', 'F', f).recognize(png, 'image/png')).rejects.toThrow(/429 quota/);
    await expect(new YandexVision('K', 'F', f).recognize(png, 'image/tiff')).rejects.toBeInstanceOf(OcrError);
  });

  it('pdfPageCount читает /Count или считает страницы', async () => {
    expect(await pdfPageCount(new TextEncoder().encode('<< /Type /Pages /Count 14 >>'))).toBe(14);
    expect(await pdfPageCount(new TextEncoder().encode('<< /Type /Page >> << /Type /Page >>'))).toBe(2);
    expect(await pdfPageCount(new TextEncoder().encode('nothing'))).toBe(1);
  });
});
