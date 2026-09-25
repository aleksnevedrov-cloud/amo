import { describe, expect, it } from 'vitest';
import { OcrError, TesseractOcr, type TesseractWorkerLike } from '../src/index.ts';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function fakeWorker(calls: { created: number; recognized: number; terminated: number }): TesseractWorkerLike {
  calls.created += 1;
  return {
    async recognize() {
      calls.recognized += 1;
      const line = (text: string, x0: number, y0: number) => ({ text, bbox: { x0, y0, x1: x0 + 100, y1: y0 + 20 } });
      return {
        data: {
          text: 'Спальня 838\n2050\nКухня 805',
          blocks: [{ paragraphs: [{ lines: [line('Спальня', 10, 100), line('838', 300, 101)] }, { lines: [line('2050', 500, 99), line('Кухня', 10, 140), line('805', 300, 141)] }] }],
        },
      };
    },
    async terminate() {
      calls.terminated += 1;
    },
  };
}

describe('TesseractOcr', () => {
  it('картинка → строки по координатам; воркер создаётся один раз и закрывается', async () => {
    const calls = { created: 0, recognized: 0, terminated: 0 };
    const ocr = new TesseractOcr(async () => fakeWorker(calls));
    const r1 = await ocr.recognize(png, 'image/png');
    const r2 = await ocr.recognize(png, 'image/jpeg');
    expect(r1.provider).toBe('tesseract');
    expect(r1.text).toBe('Спальня\t838\t2050\nКухня\t805');
    expect(r2.text).toBe(r1.text);
    expect(calls).toEqual({ created: 1, recognized: 2, terminated: 0 });
    await ocr.close();
    expect(calls.terminated).toBe(1);
  });

  it('PDF и неизвестный формат — понятная ошибка без запуска воркера', async () => {
    const calls = { created: 0, recognized: 0, terminated: 0 };
    const ocr = new TesseractOcr(async () => fakeWorker(calls));
    await expect(ocr.recognize(png, 'application/pdf')).rejects.toThrow(/Yandex Vision/);
    await expect(ocr.recognize(png, 'image/tiff')).rejects.toBeInstanceOf(OcrError);
    expect(calls.created).toBe(0);
  });

  it('сбой запуска воркера — OcrError, следующая попытка запускает заново', async () => {
    let attempt = 0;
    const calls = { created: 0, recognized: 0, terminated: 0 };
    const ocr = new TesseractOcr(async () => {
      if (++attempt === 1) throw new Error('нет языковых данных');
      return fakeWorker(calls);
    });
    await expect(ocr.recognize(png, 'image/png')).rejects.toThrow(/Tesseract не запустился: нет языковых данных/);
    expect((await ocr.recognize(png, 'image/png')).text).toContain('Спальня');
  });
});
