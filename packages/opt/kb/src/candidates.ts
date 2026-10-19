import ExcelJS from 'exceljs';
import type { Db } from '@core/db';
import type { KbSource } from './repo.ts';

/**
 * KP-AGENT-V2, п. 4.4: «кандидат в прайс» — цена, подтверждённая менеджером в КП (выбранная из интернета или введённая).
 * В подбор следующих КП не попадает (подбор — только строки прайса); вкладка в виджете и выгрузка xlsx для Excel-прайса.
 */
export interface KbPriceCandidate {
  id: number;
  accountId: number;
  leadId: number | null;
  draftId: number | null;
  model: string;
  size: string | null;
  price: number;
  source: 'web_confirmed' | 'manager';
  url: string | null;
  note: string | null;
  createdBy: number | null;
  createdAt: Date;
}

export type NewKbPriceCandidate = Omit<KbPriceCandidate, 'id' | 'createdAt'>;

const mapCandidate = (r: Record<string, unknown>): KbPriceCandidate => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  leadId: r.lead_id === null ? null : Number(r.lead_id),
  draftId: r.draft_id === null ? null : Number(r.draft_id),
  model: String(r.model),
  size: (r.size ?? null) as string | null,
  price: Number(r.price),
  source: r.source as KbPriceCandidate['source'],
  url: (r.url ?? null) as string | null,
  note: (r.note ?? null) as string | null,
  createdBy: r.created_by === null ? null : Number(r.created_by),
  createdAt: r.created_at as Date,
});

export class KbPriceCandidatesRepo {
  constructor(private readonly db: Db) {}

  /** Одна позиция одного черновика — одна запись: повторное подтверждение обновляет цену и источник. */
  async upsert(c: NewKbPriceCandidate): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO kb_price_candidates (account_id, lead_id, draft_id, model, size, price, source, url, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (account_id, coalesce(draft_id, 0), model, coalesce(size, ''))
       DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source, url = EXCLUDED.url, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()
       RETURNING id`,
      [c.accountId, c.leadId, c.draftId, c.model.trim().slice(0, 300), c.size?.trim() || null, c.price, c.source, c.url, c.note?.slice(0, 500) ?? null, c.createdBy],
    );
    return Number(rows[0]?.id);
  }

  async list(accountId: number): Promise<KbPriceCandidate[]> {
    const { rows } = await this.db.query('SELECT * FROM kb_price_candidates WHERE account_id = $1 ORDER BY created_at DESC, id DESC', [accountId]);
    return rows.map(mapCandidate);
  }

  async remove(accountId: number, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM kb_price_candidates WHERE account_id = $1 AND id = $2', [accountId, id]);
    return (rowCount ?? 0) > 0;
  }
}

const SOURCE_TITLE: Record<KbPriceCandidate['source'], string> = { web_confirmed: 'интернет, выбрал менеджер', manager: 'введена менеджером' };

/** Кандидаты в прайс → xlsx: колонки для переноса в Excel-прайс заказчика. */
export async function exportCandidatesXlsx(rows: KbPriceCandidate[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Агент опт — кандидаты в прайс';
  const ws = wb.addWorksheet('Кандидаты в прайс');
  ws.columns = [
    { header: 'Модель', key: 'model', width: 50 },
    { header: 'Размер', key: 'size', width: 14 },
    { header: 'Цена с НДС, ₽', key: 'price', width: 14 },
    { header: 'Источник', key: 'source', width: 24 },
    { header: 'Ссылка', key: 'url', width: 40 },
    { header: 'Сделка', key: 'lead', width: 12 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Примечание', key: 'note', width: 40 },
  ];
  for (const r of rows) ws.addRow({ model: r.model, size: r.size ?? '', price: r.price, source: SOURCE_TITLE[r.source], url: r.url ?? '', lead: r.leadId ?? '', date: r.createdAt.toISOString().slice(0, 10), note: r.note ?? '' });
  ws.getRow(1).font = { bold: true };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Сайты-источники → xlsx (п. 4а.3): адрес, название, «фабрика», комментарий. */
export async function exportSitesXlsx(sites: KbSource[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Сайты');
  ws.columns = [
    { header: 'Адрес', key: 'url', width: 40 },
    { header: 'Название', key: 'title', width: 30 },
    { header: 'Фабрика', key: 'factory', width: 10 },
    { header: 'Комментарий', key: 'comment', width: 80 },
  ];
  for (const s of sites) ws.addRow({ url: s.original ?? '', title: s.title, factory: s.isFactory ? 'да' : '', comment: s.comment ?? '' });
  ws.getRow(1).font = { bold: true };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Загрузка сайтов из xlsx: по шапке «Адрес / Фабрика / Комментарий»; строка без адреса пропускается. */
export async function readSitesXlsx(bytes: Uint8Array): Promise<{ url: string; title: string | null; isFactory: boolean; comment: string | null }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const text = (v: ExcelJS.CellValue) => (v === null || v === undefined ? '' : typeof v === 'object' && 'text' in v ? String(v.text) : typeof v === 'object' && 'richText' in v ? v.richText.map((x) => x.text).join('') : String(v)).trim();
  const head = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => text(v).toLowerCase());
  const col = (rx: RegExp) => head.findIndex((h) => rx.test(h));
  const cUrl = col(/адрес|ссылк|url|сайт/);
  const cTitle = col(/назван/);
  const cFactory = col(/фабрик|производител/);
  const cComment = col(/коммент/);
  if (cUrl < 0) throw new Error('в файле нет колонки «Адрес»');
  const out: { url: string; title: string | null; isFactory: boolean; comment: string | null }[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.values as ExcelJS.CellValue[];
    const url = text(v[cUrl]);
    if (!/^https?:\/\/|^[a-zа-я0-9-]+\.[a-zа-я]{2,}/i.test(url)) return;
    out.push({ url: /^https?:/i.test(url) ? url : `https://${url}`, title: cTitle > 0 ? text(v[cTitle]) || null : null, isFactory: cFactory > 0 && /^(да|1|true|x|\+|фабрика)$/i.test(text(v[cFactory])), comment: cComment > 0 ? text(v[cComment]).slice(0, 2000) || null : null });
  });
  return out;
}
