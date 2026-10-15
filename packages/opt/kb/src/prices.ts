import type { Db } from '@core/db';
import { normalizeKey } from './chunk.ts';
import { leavesOf, modelKeyOf, sizeLabel, sizeOf, tokensOf } from './model-key.ts';

/**
 * Структурные цены базы знаний (kb_prices) и синонимы (kb_aliases) — RFD-AI-AGENT-OPT-KB, этап 3.
 * Приоритет цены: база (точное совпадение модели и размера → базовая цена × правила нестандарта) → веб-поиск.
 * Найденное веб-поиском попадает сюда с доверием 40, правки менеджера — 90.
 */
export type PriceOrigin = 'price_list' | 'web' | 'manager' | 'purchase';
export type PriceVat = 'included' | 'no_vat' | 'unknown';

/** Правила нестандарта: доплаты в процентах к базовой цене. */
export interface NonstandardRules {
  /** Доплата за высоту выше базовой (или выше heightOverMm), %. */
  heightPct?: number;
  heightOverMm?: number;
  widthPct?: number;
  widthOverMm?: number;
  /** Доплата за толщину полотна больше стандартной, % (применяется, если в позиции указана толщина больше thicknessOverMm). */
  thicknessPct?: number;
  thicknessOverMm?: number;
  /** Доплата за двупольное исполнение, %. */
  doubleLeafPct?: number;
  /** Пересчитывать по площади при другом размере без правил; по умолчанию да. */
  areaScale?: boolean;
}

export const DEFAULT_CONFIDENCE: Record<PriceOrigin, number> = { price_list: 70, web: 40, manager: 90, purchase: 80 };
/** Срок актуальности, дни (ТЗ раздел 5): прайс 90, страница сайта 30, веб-поиск 30; правка менеджера и закупка — как прайс. */
export const VALIDITY_DAYS = { price_list: 90, url: 30, web: 30, manager: 90, purchase: 90 } as const;

export interface KbPrice {
  id: number;
  accountId: number;
  sourceId: number | null;
  model: string;
  modelKey: string;
  factory: string | null;
  unit: string;
  baseSize: string | null;
  widthMm: number | null;
  heightMm: number | null;
  price: number;
  vat: PriceVat;
  currency: string;
  validAt: Date;
  confidence: number;
  origin: PriceOrigin;
  nonstandard: NonstandardRules;
  url: string | null;
  note: string | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  /** Подпись источника (kb_sources.title) и его вид — для подписи «по базе: прайс Текона 01.10.2026». */
  sourceTitle: string | null;
  sourceKind: 'file' | 'url' | 'text' | null;
}

export interface NewKbPrice {
  accountId: number;
  sourceId?: number | null;
  model: string;
  factory?: string | null;
  unit?: string;
  widthMm?: number | null;
  heightMm?: number | null;
  price: number;
  vat?: PriceVat;
  validAt?: Date;
  confidence?: number;
  origin: PriceOrigin;
  nonstandard?: NonstandardRules;
  url?: string | null;
  note?: string | null;
  createdBy?: number | null;
}

export interface KbAlias {
  id: number;
  accountId: number;
  alias: string;
  aliasKey: string;
  canonical: string;
  canonicalKey: string;
  sourceId: number | null;
  createdAt: Date;
}

const SELECT = `SELECT p.*, s.title AS source_title, s.kind AS source_kind FROM kb_prices p LEFT JOIN kb_sources s ON s.id = p.source_id`;

export class KbPricesRepo {
  constructor(private readonly db: Db) {}

  /** Запись цены; одна запись на аккаунт + модель + размер + происхождение + источник — повтор обновляет. */
  async upsert(p: NewKbPrice): Promise<number> {
    const modelKey = modelKeyOf(p.model) || normalizeKey(p.model);
    const width = p.widthMm ?? null;
    const height = p.heightMm ?? null;
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO kb_prices (account_id, source_id, model, model_key, factory, unit, base_size, width_mm, height_mm, price, vat, valid_at, confidence, origin, nonstandard, url, note, created_by)
       SELECT $1::bigint, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::text, $8::int, $9::int, $10::numeric, $11::text, $12::date, $13::int, $14::text, $15::jsonb, $16::text, $17::text, $18::bigint
       WHERE NOT EXISTS (SELECT 1 FROM kb_prices WHERE account_id = $1::bigint AND model_key = $4::text AND coalesce(base_size, '') = coalesce($7::text, '') AND origin = $14::text AND coalesce(source_id, 0) = coalesce($2::bigint, 0))
       RETURNING id`,
      [p.accountId, p.sourceId ?? null, p.model.trim().slice(0, 300), modelKey, p.factory?.trim() || null, p.unit ?? 'шт', sizeLabel(width, height), width, height, p.price, p.vat ?? 'unknown', p.validAt ?? new Date(), p.confidence ?? DEFAULT_CONFIDENCE[p.origin], p.origin, JSON.stringify(p.nonstandard ?? {}), p.url ?? null, p.note ?? null, p.createdBy ?? null],
    );
    if (rows[0]) return Number(rows[0].id);
    const upd = await this.db.query<{ id: string }>(
      `UPDATE kb_prices SET model = $3::text, factory = COALESCE($5::text, factory), unit = $6::text, width_mm = $8::int, height_mm = $9::int, price = $10::numeric, vat = $11::text, valid_at = $12::date, confidence = $13::int, nonstandard = $15::jsonb, url = COALESCE($16::text, url), note = COALESCE($17::text, note), created_by = COALESCE($18::bigint, created_by), updated_at = now()
        WHERE account_id = $1::bigint AND model_key = $4::text AND coalesce(base_size, '') = coalesce($7::text, '') AND origin = $14::text AND coalesce(source_id, 0) = coalesce($2::bigint, 0)
        RETURNING id`,
      [p.accountId, p.sourceId ?? null, p.model.trim().slice(0, 300), modelKey, p.factory?.trim() || null, p.unit ?? 'шт', sizeLabel(width, height), width, height, p.price, p.vat ?? 'unknown', p.validAt ?? new Date(), p.confidence ?? DEFAULT_CONFIDENCE[p.origin], p.origin, JSON.stringify(p.nonstandard ?? {}), p.url ?? null, p.note ?? null, p.createdBy ?? null],
    );
    return Number(upd.rows[0]?.id ?? 0);
  }

  /** Импорт прайса из источника: прежние записи этого источника заменяются. */
  async replaceForSource(accountId: number, sourceId: number, rows: Omit<NewKbPrice, 'accountId' | 'sourceId'>[]): Promise<number> {
    await this.db.query('DELETE FROM kb_prices WHERE account_id = $1 AND source_id = $2', [accountId, sourceId]);
    let n = 0;
    for (const r of rows) {
      if (await this.upsert({ ...r, accountId, sourceId })) n += 1;
    }
    return n;
  }

  async byId(accountId: number, id: number): Promise<KbPrice | null> {
    const { rows } = await this.db.query(`${SELECT} WHERE p.account_id = $1 AND p.id = $2`, [accountId, id]);
    return rows[0] ? mapPrice(rows[0]) : null;
  }

  async list(accountId: number, opts: { q?: string; sourceId?: number; limit?: number; offset?: number } = {}): Promise<{ items: KbPrice[]; total: number }> {
    const q = opts.q?.trim() ? `%${normalizeKey(opts.q)}%` : null;
    const where = `p.account_id = $1 AND ($2::text IS NULL OR p.model_key LIKE $2 OR lower(coalesce(p.factory, '')) LIKE $2) AND ($3::bigint IS NULL OR p.source_id = $3)`;
    const [{ rows }, total] = await Promise.all([
      this.db.query(`${SELECT} WHERE ${where} ORDER BY p.model_key, p.base_size NULLS LAST, p.confidence DESC, p.valid_at DESC LIMIT $4 OFFSET $5`, [accountId, q, opts.sourceId ?? null, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0]),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM kb_prices p WHERE ${where}`, [accountId, q, opts.sourceId ?? null]),
    ]);
    return { items: rows.map(mapPrice), total: total.rows[0]?.n ?? 0 };
  }

  async update(accountId: number, id: number, patch: Partial<Pick<NewKbPrice, 'model' | 'factory' | 'unit' | 'widthMm' | 'heightMm' | 'price' | 'vat' | 'validAt' | 'confidence' | 'nonstandard' | 'url' | 'note'>>): Promise<KbPrice | null> {
    const cur = await this.byId(accountId, id);
    if (!cur) return null;
    const model = patch.model ?? cur.model;
    const width = patch.widthMm === undefined ? cur.widthMm : patch.widthMm;
    const height = patch.heightMm === undefined ? cur.heightMm : patch.heightMm;
    await this.db.query(
      `UPDATE kb_prices SET model = $3, model_key = $4, factory = $5, unit = $6, base_size = $7, width_mm = $8, height_mm = $9, price = $10, vat = $11, valid_at = $12, confidence = $13, nonstandard = $14::jsonb, url = $15, note = $16, updated_at = now()
        WHERE account_id = $1 AND id = $2`,
      [accountId, id, model.trim().slice(0, 300), modelKeyOf(model) || normalizeKey(model), (patch.factory === undefined ? cur.factory : patch.factory)?.trim() || null, patch.unit ?? cur.unit, sizeLabel(width, height), width, height, patch.price ?? cur.price, patch.vat ?? cur.vat, patch.validAt ?? cur.validAt, patch.confidence ?? cur.confidence, JSON.stringify(patch.nonstandard ?? cur.nonstandard), patch.url === undefined ? cur.url : patch.url, patch.note === undefined ? cur.note : patch.note],
    );
    return this.byId(accountId, id);
  }

  async remove(accountId: number, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM kb_prices WHERE account_id = $1 AND id = $2', [accountId, id]);
    return (rowCount ?? 0) > 0;
  }

  /** Все цены аккаунта — для выгрузки в xlsx. */
  async all(accountId: number): Promise<KbPrice[]> {
    const { rows } = await this.db.query(`${SELECT} WHERE p.account_id = $1 ORDER BY p.model_key, p.base_size NULLS LAST, p.confidence DESC`, [accountId]);
    return rows.map(mapPrice);
  }

  /** Кандидаты по ключам модели: точные, модель базы целиком внутри названия позиции («турин» в «браво турин белая эмаль»), похожие по триграммам (≥ 0.55). */
  async candidates(accountId: number, keys: string[]): Promise<{ row: KbPrice; similarity: number }[]> {
    const list = [...new Set(keys.filter(Boolean))];
    if (!list.length) return [];
    const sim = `GREATEST(${list.map((_, i) => `similarity(p.model_key, $${i + 2}::text)`).join(', ')})`;
    // Модель базы внутри названия позиции или название позиции внутри модели базы («турин» ↔ «браво турин»).
    const inside = list.map((_, i) => `(position(' ' || p.model_key || ' ' in ' ' || $${i + 2}::text || ' ') > 0 OR position(' ' || $${i + 2}::text || ' ' in ' ' || p.model_key || ' ') > 0)`).join(' OR ');
    const { rows } = await this.db.query(
      `${SELECT}, ${sim} AS sim
        WHERE p.account_id = $1 AND (p.model_key = ANY($${list.length + 2}::text[]) OR ${inside} OR ${sim} >= 0.55)
        ORDER BY sim DESC, p.confidence DESC, p.valid_at DESC LIMIT 50`,
      [accountId, ...list, list],
    );
    return rows.map((r) => ({ row: mapPrice(r), similarity: Number(r.sim ?? 0) }));
  }
}

export class KbAliasesRepo {
  constructor(private readonly db: Db) {}

  async add(accountId: number, alias: string, canonical: string, opts: { sourceId?: number | null; createdBy?: number | null } = {}): Promise<number> {
    const aliasKey = modelKeyOf(alias) || normalizeKey(alias);
    const canonicalKey = modelKeyOf(canonical) || normalizeKey(canonical);
    if (!aliasKey || !canonicalKey) throw new Error('Пустой синоним');
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO kb_aliases (account_id, alias, alias_key, canonical, canonical_key, source_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_id, alias_key) DO UPDATE SET alias = EXCLUDED.alias, canonical = EXCLUDED.canonical, canonical_key = EXCLUDED.canonical_key
       RETURNING id`,
      [accountId, alias.trim().slice(0, 300), aliasKey, canonical.trim().slice(0, 300), canonicalKey, opts.sourceId ?? null, opts.createdBy ?? null],
    );
    return Number(rows[0]?.id ?? 0);
  }

  /** Строка «ДПГ сота = ДПГ + УПД (сота) = дверь глухая ламинированная сотовое заполнение»: первое — каноническое, остальные — синонимы. */
  async addLine(accountId: number, line: string, opts: { createdBy?: number | null } = {}): Promise<number> {
    const parts = line.split(/\s*(?:=|;|→|->)\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) throw new Error('Нужно хотя бы два названия через «=»');
    const canonical = parts[0] as string;
    let n = 0;
    for (const alias of parts.slice(1)) {
      await this.add(accountId, alias, canonical, opts);
      n += 1;
    }
    return n;
  }

  async list(accountId: number): Promise<KbAlias[]> {
    const { rows } = await this.db.query('SELECT * FROM kb_aliases WHERE account_id = $1 ORDER BY canonical_key, alias_key', [accountId]);
    return rows.map(mapAlias);
  }

  async remove(accountId: number, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM kb_aliases WHERE account_id = $1 AND id = $2', [accountId, id]);
    return (rowCount ?? 0) > 0;
  }

  /** Каноническое название по ключу синонима (и наоборот: каноническое знает все свои синонимы). */
  async resolve(accountId: number, key: string): Promise<{ canonical: string; canonicalKey: string; keys: string[] } | null> {
    if (!key) return null;
    const { rows } = await this.db.query('SELECT * FROM kb_aliases WHERE account_id = $1 AND (alias_key = $2 OR canonical_key = $2) LIMIT 1', [accountId, key]);
    const hit = rows[0] ? mapAlias(rows[0]) : null;
    if (!hit) return null;
    const all = await this.db.query<{ alias_key: string }>('SELECT alias_key FROM kb_aliases WHERE account_id = $1 AND canonical_key = $2', [accountId, hit.canonicalKey]);
    return { canonical: hit.canonical, canonicalKey: hit.canonicalKey, keys: [...new Set([hit.canonicalKey, ...all.rows.map((r) => r.alias_key)])] };
  }
}

/** Что ищем в базе цен: позиция заявки. */
export interface PriceQuery {
  name: string;
  raw?: string;
  widthMm?: number | null;
  heightMm?: number | null;
  leaves?: number | null;
  thicknessMm?: number | null;
}

export interface PriceHit {
  row: KbPrice;
  /** Цена за единицу позиции после правил. */
  price: number;
  /** exact — модель и размер совпали; rules — правила нестандарта; area — пересчёт по площади; base — размер в прайсе не указан. */
  basis: 'exact' | 'rules' | 'area' | 'base';
  /** Совпадение модели: точное, по синониму, по вхождению слов, по похожести. */
  match: 'exact' | 'alias' | 'tokens' | 'similar';
  similarity: number;
  /** Срок актуальности вышел — цена ставится с пометкой «цена устарела». */
  stale: boolean;
  validityDays: number;
  notes: string[];
  /** Подпись для плитки: «по базе: прайс Текона (01.10.2026)», «по закупке», «по рынку (кэш 05.10.2026)», «изменено менеджером». */
  label: string;
}

export function validityDaysOf(row: Pick<KbPrice, 'origin' | 'sourceKind'>): number {
  if (row.origin === 'price_list') return row.sourceKind === 'url' ? VALIDITY_DAYS.url : VALIDITY_DAYS.price_list;
  return VALIDITY_DAYS[row.origin];
}

export function priceLabelOf(row: Pick<KbPrice, 'origin' | 'sourceTitle' | 'factory' | 'validAt'>): string {
  const d = row.validAt.toLocaleDateString('ru-RU');
  switch (row.origin) {
    case 'manager':
      return 'изменено менеджером';
    case 'purchase':
      return `по закупке (${d})`;
    case 'web':
      return `по рынку (${d})`;
    default:
      return `по базе: ${row.sourceTitle ?? (row.factory ? `прайс ${row.factory}` : 'прайс')} (${d})`;
  }
}

/** Слова цвета и отделки: сами по себе моделью не считаются. */
const FINISH_WORDS = new Set(['белый', 'белая', 'белое', 'серый', 'серая', 'черный', 'черная', 'дуб', 'венге', 'орех', 'ясень', 'эмаль', 'пвх', 'шпон', 'экошпон', 'ламинат', 'ламинированная', 'ламинированное', 'стекло', 'сатинат', 'глухая', 'глухое', 'остекленная', 'остекленное', 'сота', 'сотовое', 'заполнение', 'массив', 'сосна', 'лиственница', 'коробка', 'добор', 'наличник', 'комплект']);

const sameSize = (a: number | null, b: number | null | undefined, tol = 5) => a !== null && b !== null && b !== undefined && Math.abs(a - b) <= tol;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Цена строки по правилам нестандарта относительно базового размера записи прайса. */
export function applyRules(row: KbPrice, q: PriceQuery): { price: number; basis: PriceHit['basis']; notes: string[] } {
  const notes: string[] = [];
  const rules = row.nonstandard ?? {};
  const w = q.widthMm ?? null;
  const h = q.heightMm ?? null;
  if (row.widthMm === null || row.heightMm === null || w === null || h === null) {
    if (w === null || h === null) notes.push('размер позиции не указан — базовая цена');
    else notes.push('в прайсе нет размера — базовая цена');
    return { price: applyLeaves(row.price, rules, q, notes), basis: 'base', notes };
  }
  if (sameSize(row.widthMm, w) && sameSize(row.heightMm, h)) return { price: applyLeaves(row.price, rules, q, notes), basis: 'exact', notes };
  let pct = 0;
  let used = false;
  if (h > (rules.heightOverMm ?? row.heightMm) + 5 && rules.heightPct) {
    pct += rules.heightPct;
    used = true;
    notes.push(`нестандарт по высоте ${h} мм: +${rules.heightPct} %`);
  }
  if (w > (rules.widthOverMm ?? row.widthMm) + 5 && rules.widthPct) {
    pct += rules.widthPct;
    used = true;
    notes.push(`нестандарт по ширине ${w} мм: +${rules.widthPct} %`);
  }
  if (q.thicknessMm && rules.thicknessPct && q.thicknessMm > (rules.thicknessOverMm ?? 40)) {
    pct += rules.thicknessPct;
    used = true;
    notes.push(`толщина ${q.thicknessMm} мм: +${rules.thicknessPct} %`);
  }
  if (used) return { price: applyLeaves(round2(row.price * (1 + pct / 100)), rules, q, notes), basis: 'rules', notes };
  if (rules.areaScale === false) {
    notes.push(`размер ${w}×${h} отличается от ${row.baseSize}, пересчёт выключен — базовая цена`);
    return { price: applyLeaves(row.price, rules, q, notes), basis: 'base', notes };
  }
  const ratio = (w * h) / (row.widthMm * row.heightMm);
  notes.push(`пересчёт по площади с ${row.baseSize} (×${ratio.toFixed(2)})`);
  return { price: applyLeaves(round2(row.price * ratio), rules, q, notes), basis: 'area', notes };
}

function applyLeaves(price: number, rules: NonstandardRules, q: PriceQuery, notes: string[]): number {
  if (q.leaves === 2 && rules.doubleLeafPct) {
    notes.push(`двупольное исполнение: +${rules.doubleLeafPct} %`);
    return round2(price * (1 + rules.doubleLeafPct / 100));
  }
  return price;
}

/**
 * Подбор цены из базы для позиции: ключ модели (с учётом синонимов) → кандидаты → совпадение модели
 * (точное › синоним › слова › похожесть) → предпочтение точного размера, затем доверие и свежесть.
 */
export async function lookupPrice(prices: KbPricesRepo, aliases: KbAliasesRepo, accountId: number, q: PriceQuery, now = new Date()): Promise<PriceHit | null> {
  const text = `${q.name} ${q.raw ?? ''}`;
  const key = modelKeyOf(q.name) || modelKeyOf(text);
  if (!key) return null;
  const alias = await aliases.resolve(accountId, key);
  const keys = alias ? [key, ...alias.keys] : [key];
  const found = await prices.candidates(accountId, keys);
  if (!found.length) return null;
  const size = { widthMm: q.widthMm ?? sizeOf(text)?.widthMm ?? null, heightMm: q.heightMm ?? sizeOf(text)?.heightMm ?? null };
  const leaves = q.leaves ?? leavesOf(text);
  const itemTokens = new Set(tokensOf(key));
  const scored = found
    .map(({ row, similarity }) => {
      let match: PriceHit['match'] | null = null;
      if (row.modelKey === key) match = 'exact';
      else if (alias && alias.keys.includes(row.modelKey)) match = 'alias';
      else {
        const t = tokensOf(row.modelKey);
        // Все слова модели из базы есть в позиции: «Турин» внутри «Браво Турин белая эмаль». Одно слово — только если это
        // не цвет/отделка и оно длиннее трёх букв (или артикул с цифрой).
        const single = t.length === 1 && (/\d/.test(t[0] ?? '') || ((t[0]?.length ?? 0) >= 4 && !FINISH_WORDS.has(t[0] ?? '')));
        if (t.length && t.every((x) => itemTokens.has(x)) && (t.length >= 2 || single)) match = 'tokens';
        else {
          // Обратное вхождение: короткое название позиции («турин») целиком внутри модели базы («браво турин»).
          const it = [...itemTokens];
          const significant = it.length === 1 ? /\d/.test(it[0] ?? '') || ((it[0]?.length ?? 0) >= 4 && !FINISH_WORDS.has(it[0] ?? '')) : it.length >= 2;
          const rowTokens = new Set(t);
          if (it.length && significant && it.every((x) => rowTokens.has(x))) match = 'tokens';
          else if (similarity >= 0.7) match = 'similar';
        }
      }
      return match ? { row, similarity, match } : null;
    })
    .filter((x): x is { row: KbPrice; similarity: number; match: PriceHit['match'] } => x !== null);
  if (!scored.length) return null;
  // Среди совпавших по модели: точный размер › правила нестандарта › пересчёт по площади › базовая цена; затем доверие, близость площади, свежесть.
  const MATCH_RANK: Record<PriceHit['match'], number> = { exact: 0, alias: 1, tokens: 2, similar: 3 };
  const BASIS_RANK: Record<PriceHit['basis'], number> = { exact: 0, rules: 1, area: 2, base: 3 };
  const area = size.widthMm && size.heightMm ? size.widthMm * size.heightMm : null;
  const closeness = (r: KbPrice) => (area && r.widthMm && r.heightMm ? Math.abs(Math.log((r.widthMm * r.heightMm) / area)) : 1);
  const ranked = scored
    .map((c) => ({ ...c, applied: applyRules(c.row, { ...q, ...size, leaves }) }))
    .sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || BASIS_RANK[a.applied.basis] - BASIS_RANK[b.applied.basis] || b.row.confidence - a.row.confidence || closeness(a.row) - closeness(b.row) || b.row.validAt.getTime() - a.row.validAt.getTime());
  const best = ranked[0] as (typeof ranked)[number];
  const applied = best.applied;
  const validityDays = validityDaysOf(best.row);
  const stale = now.getTime() - best.row.validAt.getTime() > validityDays * 86_400_000;
  const notes = [...applied.notes];
  if (best.match === 'alias') notes.push(`по синониму: ${best.row.model}`);
  if (best.match === 'tokens' || best.match === 'similar') notes.push(`похожая модель в базе: ${best.row.model}${best.row.factory ? ` (${best.row.factory})` : ''}`);
  if (stale) notes.push(`цена устарела: актуальна на ${best.row.validAt.toLocaleDateString('ru-RU')}, срок ${validityDays} дн.`);
  return { row: best.row, price: applied.price, basis: applied.basis, match: best.match, similarity: best.similarity, stale, validityDays, notes, label: priceLabelOf(best.row) };
}

function mapPrice(r: Record<string, unknown>): KbPrice {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    sourceId: r.source_id === null || r.source_id === undefined ? null : Number(r.source_id),
    model: String(r.model ?? ''),
    modelKey: String(r.model_key ?? ''),
    factory: (r.factory ?? null) as string | null,
    unit: String(r.unit ?? 'шт'),
    baseSize: (r.base_size ?? null) as string | null,
    widthMm: r.width_mm === null || r.width_mm === undefined ? null : Number(r.width_mm),
    heightMm: r.height_mm === null || r.height_mm === undefined ? null : Number(r.height_mm),
    price: Number(r.price),
    vat: r.vat as PriceVat,
    currency: String(r.currency ?? 'RUB'),
    validAt: r.valid_at instanceof Date ? r.valid_at : new Date(String(r.valid_at)),
    confidence: Number(r.confidence ?? 0),
    origin: r.origin as PriceOrigin,
    nonstandard: (r.nonstandard ?? {}) as NonstandardRules,
    url: (r.url ?? null) as string | null,
    note: (r.note ?? null) as string | null,
    createdBy: r.created_by === null || r.created_by === undefined ? null : Number(r.created_by),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    sourceTitle: (r.source_title ?? null) as string | null,
    sourceKind: (r.source_kind ?? null) as KbPrice['sourceKind'],
  };
}

function mapAlias(r: Record<string, unknown>): KbAlias {
  return { id: Number(r.id), accountId: Number(r.account_id), alias: String(r.alias ?? ''), aliasKey: String(r.alias_key ?? ''), canonical: String(r.canonical ?? ''), canonicalKey: String(r.canonical_key ?? ''), sourceId: r.source_id === null || r.source_id === undefined ? null : Number(r.source_id), createdAt: r.created_at as Date };
}
