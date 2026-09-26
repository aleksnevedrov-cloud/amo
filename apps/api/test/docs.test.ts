import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedLlm, text } from '../../../packages/agent/test/scripted-llm.ts';
import { setup, widgetToken } from './helpers.ts';

let ctx: Awaited<ReturnType<typeof setup>>;
const steps: ConstructorParameters<typeof ScriptedLlm>[0] = [];

const doc = {
  kind: 'measurement',
  title: 'Замерный лист',
  summary: 'Один проём в спальню.',
  customer_type: 'b2c',
  openings: [{ room: 'Спальня', label: null, width_mm: 838, height_mm: 2050, wall_mm: 105, leaf_width_mm: null, qty: 1, double: null, side: null, note: null }],
  positions: [],
  requirements: [],
  questions: ['Цвет полотна?'],
  photo: null,
};

beforeAll(async () => {
  ctx = await setup({ llm: new ScriptedLlm(steps) });
  await ctx.app.inject({ url: '/oauth/amo/callback', query: { code: 'C', referer: 'aleksnevedrov.amocrm.ru', from_widget: '1' } });
});
afterAll(async () => ctx.close());

const headers = async () => ({ 'x-auth-token': await widgetToken() });

async function xlsx(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Замер');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('разбор файла из карточки сделки', () => {
  it('XLSX: результат, примечание в сделку, память клиента, журнал, список', async () => {
    steps.push(text(JSON.stringify(doc)));
    const file = await xlsx([['Помещение', 'Ширина', 'Высота', 'Стена'], ['Спальня', 838, 2050, 105], ['Замерщик: Петров П.П., +7 912 000-00-00']]);
    const res = await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/700/documents', headers: await headers(), payload: { name: 'замер.xlsx', mime: '', file } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ kind: 'measurement', noted: true, ocr: null });
    expect(body.kit.lines[0]).toMatchObject({ leaf_width_mm: 700, leaf_height_mm: 2000, boxes: 2.5, casings: 5, extensions: 2.5, extension_width_mm: 100 });
    expect(body.piiRemoved).toBeGreaterThan(0);
    // В LLM ушёл текст без ФИО и телефона.
    const llmReq = JSON.stringify((ctx.deps.llm as ScriptedLlm).requests.at(-1));
    expect(llmReq).toContain('Спальня\\t838\\t2050\\t105');
    expect(llmReq).not.toMatch(/Петров|000-00-00/);
    // Примечание в amo и память по основному контакту (77 из мока).
    const note = ctx.amo.calls.find((c) => c.url.endsWith('/leads/700/notes'));
    expect(JSON.stringify(note?.body)).toContain('Разбор файла «замер.xlsx»');
    expect((await ctx.deps.memory.get(31337, 'contact:77')).data.openings).toEqual([{ room: 'Спальня', width_mm: 838, height_mm: 2050, wall_mm: 105, qty: 1 }]);
    const list = await ctx.app.inject({ url: '/widget/v1/leads/700/documents', headers: await headers() });
    expect(list.json().items).toMatchObject([{ kind: 'measurement', filename: 'замер.xlsx', openings: 1, positions: 0, source: 'widget' }]);
    const journal = await ctx.app.inject({ url: '/widget/v1/journal?leadId=700&kind=document', headers: await headers() });
    expect(journal.json().items[0]).toMatchObject({ summary: 'Разобран файл «замер.xlsx» (measurement)' });
    expect(journal.json().items[0].costRub).toBeGreaterThan(0);
  });

  it('неподдерживаемый формат — понятная ошибка 422 и запись в журнале', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/701/documents', headers: await headers(), payload: { name: 'архив.zip', mime: 'application/zip', file: Buffer.from('zip').toString('base64') } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'document', message: expect.stringContaining('не поддерживается') });
    // DWG без конвертера на сервере — понятная подсказка.
    process.env.DWG2DXF_BIN = '/nonexistent/dwg2dxf';
    const dwg = await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/701/documents', headers: await headers(), payload: { name: 'план.dwg', mime: 'application/acad', file: Buffer.from('AC1027').toString('base64') } });
    delete process.env.DWG2DXF_BIN;
    expect(dwg.statusCode).toBe(422);
    expect(dwg.json().message).toContain('LibreDWG');
  });

  it('OCR выключен в настройках — 422 с подсказкой про настройку', async () => {
    const { settings } = await ctx.deps.settings.get(31337);
    await ctx.deps.settings.save(31337, 1, { ...settings, vision: { ...settings.vision, provider: 'off' } });
    const res = await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/702/documents', headers: await headers(), payload: { name: 'IMG.jpg', mime: 'image/jpeg', file: Buffer.from([0xff, 0xd8]).toString('base64') } });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('выключено');
    await ctx.deps.settings.save(31337, 1, settings);
  });

  it('пустой или битый файл — 400', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/widget/v1/leads/703/documents', headers: await headers(), payload: { name: 'x.pdf', file: '' } });
    expect(res.statusCode).toBe(400);
  });
});
