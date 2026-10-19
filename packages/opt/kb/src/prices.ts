import { withTransaction, type Db } from '@core/db';
import { normalizeKey } from './chunk.ts';
import { priceListTitleOf } from './price-key.ts';
import { categoryOf, componentKindOf, type ComponentKind, type PositionCategory } from './category.ts';
import type { BookDictionaryEntry, BookRule, BookSize, ComponentStatus, ProductCard, ProductStatus, Family, UnitBasis } from './price-book.ts';
import { nonstandardBySizes } from './book-pricing.ts';
import { profileConflicts, profileOf, profileOfRow, type GostProfile } from './gost-profile.ts';
import { colorOf, withoutEdge, describeFeatures, featureKeyOf, featuresOf, hasFeatures, matchFeatures, mergeFeatures, priceListMedian, type DoorFeatures, type FeatureKey, type FeatureMatch } from './features.ts';
import { leavesOf, modelKeyOf, searchTokensOf, sizeLabel, sizeOf, tokensOf } from './model-key.ts';

/** Куда писать: пул или клиент транзакции. */
type Queryable = Pick<Db, 'query'>;

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
  /** Цена за единицу; null — в прайсе цены нет (фурнитура «Дополнений» со статусом not_priced, KB-HW-NULL). */
  price: number | null;
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
  /** Прайс (KB-PRICELIST, г): «Сокращение в названии», «Назначение/Конструкция», их ключи, слова подбора, строка прайса. */
  abbr: string | null;
  description: string | null;
  altKeys: string[];
  searchTokens: string[];
  sourceRow: number | null;
  /** Признаки двери (KB-MATCH): из колонок прайса или текста; ключ группы по обязательным признакам. */
  features: DoorFeatures | null;
  featureKey: string | null;
  /** Текст колонок прайса «Покрытие» («CPL 0,2 мм») и «Комплектация» («коробка, 3 петли, …») — в наименование строки КП (KP-NAME). */
  coating: string | null;
  equipment: string | null;
  /** Ключ и короткое название прайса-файла (KB-MULTIPRICE): «прайс межкомнатные двери гост» / «Межкомнатные»; у веб-цен и правок — null. */
  priceKey: string | null;
  priceTitle: string | null;
  /** Категория записи (KB-COMPONENTS): дверь / комплектующее / фурнитура / работы; componentKind — вид комплектующего. */
  category: PositionCategory;
  componentKind: ComponentKind | null;
  /** Карточка товара из многолистового прайса (KB-PRICE-SHEETS): ID товара / тарифа, статус, сметная цена, семейство, статусы компонентов, карточка. */
  productId: string | null;
  tariffId: string | null;
  status: ProductStatus;
  estimate: boolean;
  family: Family | null;
  /** Фурнитура: для каких ID товаров; пусто — для всех. */
  appliesTo: string[];
  componentStatus: Partial<Record<ComponentKind, ComponentStatus>> | null;
  card: ProductCard | null;
}

export interface NewKbPrice {
  accountId: number;
  sourceId?: number | null;
  model: string;
  factory?: string | null;
  unit?: string;
  widthMm?: number | null;
  heightMm?: number | null;
  /** null — цены нет (тариф «Дополнений» без цены); у прайса 0 не записывается. */
  price: number | null;
  vat?: PriceVat;
  validAt?: Date;
  confidence?: number;
  origin: PriceOrigin;
  nonstandard?: NonstandardRules;
  url?: string | null;
  note?: string | null;
  createdBy?: number | null;
  abbr?: string | null;
  description?: string | null;
  sourceRow?: number | null;
  /** Явные признаки (из колонок прайса или разбора письма); из текста модели/сокращения/назначения извлекаются всегда. */
  features?: Partial<DoorFeatures> | null;
  coating?: string | null;
  equipment?: string | null;
  /** Категория записи; не задана — по тексту модели (без ключевых слов — дверь). */
  category?: PositionCategory | null;
  componentKind?: ComponentKind | null;
  productId?: string | null;
  tariffId?: string | null;
  status?: ProductStatus | null;
  estimate?: boolean | null;
  family?: Family | null;
  appliesTo?: string[] | null;
  componentStatus?: Partial<Record<ComponentKind, ComponentStatus>> | null;
  card?: ProductCard | null;
}

export interface KbSize {
  id: number;
  productId: string;
  sizeId: string | null;
  widthMm: number;
  heightMm: number;
  basis: string | null;
  leafWidthsMm: number[] | null;
}

export interface KbDictionaryEntry {
  id: number;
  sheet: string;
  term: string;
  termKey: string;
  meaning: string | null;
  context: string | null;
  rule: string | null;
  sourceId: number;
}

export interface BookCounts {
  doors: number;
  components: number;
  hardware: number;
  sizes: number;
  aliases: number;
  comments: number;
  dictionary: number;
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
  /** ID товара из многолистового прайса (KB-PRICE-SHEETS); у ручных синонимов — null. */
  productId: string | null;
}

const SELECT = `SELECT p.*, s.title AS source_title, s.kind AS source_kind, s.price_key AS price_key FROM kb_prices p LEFT JOIN kb_sources s ON s.id = p.source_id`;

export class KbPricesRepo {
  constructor(private readonly db: Db) {}

  /** Запись цены; одна запись на аккаунт + модель + размер + происхождение + источник — повтор обновляет. */
  upsert(p: NewKbPrice): Promise<number> {
    return this.upsertWith(this.db, p);
  }

  private async upsertWith(q: Queryable, p: NewKbPrice): Promise<number> {
    const modelKey = modelKeyOf(p.model) || normalizeKey(p.model);
    const width = p.widthMm ?? null;
    const height = p.heightMm ?? null;
    const abbr = p.abbr?.trim().slice(0, 300) || null;
    const description = p.description?.trim().slice(0, 1000) || null;
    // Ключи сокращения и назначения — дополнительные точные ключи подбора; слова — для подбора по словам (г).
    const altKeys = [...new Set([abbr, description].map((t) => (t ? modelKeyOf(t) : '')).filter((k) => k && k !== modelKey))];
    const searchTokens = searchTokensOf(p.model, abbr, description);
    // Признаки (KB-MATCH): из текста модели, сокращения и назначения, явные значения сверху.
    const features = mergeFeatures(featuresOf([p.model, abbr, description].filter(Boolean).join(' | ')), p.features);
    // Категория (KB-COMPONENTS): явная или по тексту модели; вид комплектующего — по модели.
    const category: PositionCategory = p.category ?? categoryOf([p.model, abbr].filter(Boolean).join(' '));
    const componentKind = p.componentKind ?? (category === 'component' ? componentKindOf(p.model) : null);
    const params = [p.accountId, p.sourceId ?? null, p.model.trim().slice(0, 300), modelKey, p.factory?.trim() || null, p.unit ?? 'шт', sizeLabel(width, height), width, height, p.price, p.vat ?? 'unknown', p.validAt ?? new Date(), p.confidence ?? DEFAULT_CONFIDENCE[p.origin], p.origin, JSON.stringify(p.nonstandard ?? {}), p.url ?? null, p.note ?? null, p.createdBy ?? null, abbr, description, altKeys, searchTokens, p.sourceRow ?? null, JSON.stringify(features), featureKeyOf(features), p.coating?.trim().slice(0, 300) || null, p.equipment?.trim().slice(0, 1000) || null, category, componentKind, p.productId ?? null, p.tariffId ?? null, p.status ?? 'active', Boolean(p.estimate), p.family ?? null, p.appliesTo ?? [], p.componentStatus ? JSON.stringify(p.componentStatus) : null, p.card ? JSON.stringify(p.card) : null, p.category !== undefined && p.category !== null];
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO kb_prices (account_id, source_id, model, model_key, factory, unit, base_size, width_mm, height_mm, price, vat, valid_at, confidence, origin, nonstandard, url, note, created_by, abbr, description, alt_keys, search_tokens, source_row, features, feature_key, coating, equipment, category, component_kind, product_id, tariff_id, status, estimate, family, applies_to, component_status, card, category_fixed)
       SELECT $1::bigint, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::text, $8::int, $9::int, $10::numeric, $11::text, $12::date, $13::int, $14::text, $15::jsonb, $16::text, $17::text, $18::bigint, $19::text, $20::text, $21::text[], $22::text[], $23::int, $24::jsonb, $25::text, $26::text, $27::text, $28::text, $29::text, $30::text, $31::text, $32::text, $33::boolean, $34::text, $35::text[], $36::jsonb, $37::jsonb, $38::boolean
       WHERE NOT EXISTS (SELECT 1 FROM kb_prices WHERE account_id = $1::bigint AND model_key = $4::text AND coalesce(base_size, '') = coalesce($7::text, '') AND origin = $14::text AND coalesce(source_id, 0) = coalesce($2::bigint, 0) AND coalesce(product_id, '') = coalesce($30::text, '') AND coalesce(tariff_id, '') = coalesce($31::text, ''))
       RETURNING id`,
      params,
    );
    if (rows[0]) return Number(rows[0].id);
    const upd = await q.query<{ id: string }>(
      `UPDATE kb_prices SET model = $3::text, factory = COALESCE($5::text, factory), unit = $6::text, width_mm = $8::int, height_mm = $9::int, price = $10::numeric, vat = $11::text, valid_at = $12::date, confidence = $13::int, nonstandard = $15::jsonb, url = COALESCE($16::text, url), note = COALESCE($17::text, note), created_by = COALESCE($18::bigint, created_by),
               abbr = COALESCE($19::text, abbr), description = COALESCE($20::text, description), alt_keys = CASE WHEN cardinality($21::text[]) > 0 THEN $21::text[] ELSE alt_keys END, search_tokens = $22::text[], source_row = COALESCE($23::int, source_row), features = $24::jsonb, feature_key = $25::text, coating = COALESCE($26::text, coating), equipment = COALESCE($27::text, equipment), category = CASE WHEN $38::boolean OR NOT category_fixed THEN $28::text ELSE category END, component_kind = CASE WHEN $38::boolean OR NOT category_fixed THEN $29::text ELSE component_kind END, category_fixed = category_fixed OR $38::boolean, product_id = $30::text, tariff_id = $31::text, status = $32::text, estimate = $33::boolean, family = $34::text, applies_to = $35::text[], component_status = $36::jsonb, card = $37::jsonb, updated_at = now()
        WHERE account_id = $1::bigint AND model_key = $4::text AND coalesce(base_size, '') = coalesce($7::text, '') AND origin = $14::text AND coalesce(source_id, 0) = coalesce($2::bigint, 0) AND coalesce(product_id, '') = coalesce($30::text, '') AND coalesce(tariff_id, '') = coalesce($31::text, '')
        RETURNING id`,
      params,
    );
    return Number(upd.rows[0]?.id ?? 0);
  }

  /**
   * Прайс — единый источник цен аккаунта (KB-PRICELIST, а): импорт заменяет цены прежнего прайса целиком, в одной
   * транзакции (удалить все price_list аккаунта → вставить новые). Правки менеджера (manager), веб-цены (web) и закупки
   * не трогаются. Возвращает число записанных цен и число удалённых прежних.
   */
  /**
   * Импорт прайса из файла (KB-MULTIPRICE): в одной транзакции удаляются цены этого файла и файлов аккаунта с тем же
   * ключом прайса (replaceSourceIds), затем вставляются новые. Цены других прайсов, правки менеджера и веб-цены не
   * трогаются. Возвращает, сколько было, сколько удалено (модель+размер, которых больше нет) и добавлено (новых).
   */
  async replacePriceList(accountId: number, sourceId: number, rows: Omit<NewKbPrice, 'accountId' | 'sourceId'>[], replaceSourceIds: number[] = []): Promise<{ imported: number; replaced: number; was: number; removed: number; added: number }> {
    return withTransaction(this.db, async (c) => {
      const ids = [...new Set([sourceId, ...replaceSourceIds])];
      const old = await c.query<{ k: string }>(`SELECT model_key || '|' || coalesce(width_mm::text, '') || '|' || coalesce(height_mm::text, '') AS k FROM kb_prices WHERE account_id = $1 AND origin = 'price_list' AND source_id = ANY($2::bigint[])`, [accountId, ids]);
      const del = await c.query(`DELETE FROM kb_prices WHERE account_id = $1 AND origin = 'price_list' AND source_id = ANY($2::bigint[])`, [accountId, ids]);
      let imported = 0;
      for (const r of rows) {
        if (await this.upsertWith(c, { ...r, accountId, sourceId, origin: 'price_list' })) imported += 1;
      }
      const fresh = await c.query<{ k: string }>(`SELECT model_key || '|' || coalesce(width_mm::text, '') || '|' || coalesce(height_mm::text, '') AS k FROM kb_prices WHERE account_id = $1 AND origin = 'price_list' AND source_id = $2`, [accountId, sourceId]);
      const oldKeys = new Set(old.rows.map((r) => r.k));
      const newKeys = new Set(fresh.rows.map((r) => r.k));
      let removed = 0;
      for (const k of oldKeys) if (!newKeys.has(k)) removed += 1;
      let added = 0;
      for (const k of newKeys) if (!oldKeys.has(k)) added += 1;
      return { imported, replaced: del.rowCount ?? 0, was: old.rowCount ?? 0, removed, added };
    });
  }

  /**
   * Импорт многолистового прайса (KB-PRICE-SHEETS): одной транзакцией заменяются все данные файлов с тем же ключом —
   * цены, размеры, правила нестандарта, словарь, синонимы товаров. Ошибка на любом шаге откатывает всё: старые данные остаются.
   */
  async replacePriceBook(
    accountId: number,
    sourceId: number,
    priceKey: string,
    data: { rows: Omit<NewKbPrice, 'accountId' | 'sourceId'>[]; sizes: BookSize[]; rule: BookRule | null; dictionary: BookDictionaryEntry[]; aliases: { productId: string; canonical: string; alias: string }[] },
    replaceSourceIds: number[] = [],
    createdBy: number | null = null,
  ): Promise<{ imported: number; replaced: number; was: number; removed: number; added: number; sizes: number; aliases: number; dictionary: number }> {
    return withTransaction(this.db, async (c) => {
      const ids = [...new Set([sourceId, ...replaceSourceIds])];
      const key = (r: { model_key: string; width_mm: number | null; height_mm: number | null }) => `${r.model_key}|${r.width_mm ?? ''}|${r.height_mm ?? ''}`;
      const old = await c.query<{ model_key: string; width_mm: number | null; height_mm: number | null }>(`SELECT model_key, width_mm, height_mm FROM kb_prices WHERE account_id = $1 AND origin = 'price_list' AND source_id = ANY($2::bigint[])`, [accountId, ids]);
      const del = await c.query(`DELETE FROM kb_prices WHERE account_id = $1 AND origin = 'price_list' AND source_id = ANY($2::bigint[])`, [accountId, ids]);
      await c.query('DELETE FROM kb_sizes WHERE account_id = $1 AND source_id = ANY($2::bigint[])', [accountId, ids]);
      await c.query('DELETE FROM kb_rules WHERE account_id = $1 AND (source_id = ANY($2::bigint[]) OR price_key = $3)', [accountId, ids, priceKey]);
      await c.query('DELETE FROM kb_dictionary WHERE account_id = $1 AND source_id = ANY($2::bigint[])', [accountId, ids]);
      await c.query('DELETE FROM kb_aliases WHERE account_id = $1 AND source_id = ANY($2::bigint[])', [accountId, ids]);
      let imported = 0;
      for (const r of data.rows) {
        if (await this.upsertWith(c, { ...r, accountId, sourceId, origin: 'price_list', createdBy: r.createdBy ?? createdBy })) imported += 1;
      }
      for (const z of data.sizes) {
        await c.query('INSERT INTO kb_sizes (account_id, source_id, product_id, size_id, width_mm, height_mm, basis, leaf_widths_mm) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)', [accountId, sourceId, z.productId, z.sizeId, z.widthMm, z.heightMm, z.basis, z.leafWidthsMm ? JSON.stringify(z.leafWidthsMm) : null]);
      }
      if (data.rule) {
        await c.query('INSERT INTO kb_rules (account_id, source_id, price_key, large_threshold_percent, regular_surcharge_percent, large_surcharge_percent, applies_to, production_note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [accountId, sourceId, priceKey, data.rule.largeThresholdPercent, data.rule.regularSurchargePercent, data.rule.largeSurchargePercent, data.rule.appliesTo, data.rule.productionNote]);
      }
      for (const d of data.dictionary) {
        await c.query('INSERT INTO kb_dictionary (account_id, source_id, sheet, term, term_key, meaning, context, rule) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [accountId, sourceId, d.sheet, d.term.slice(0, 300), modelKeyOf(d.term) || normalizeKey(d.term), d.meaning, d.context, d.rule]);
      }
      let aliases = 0;
      for (const a of data.aliases) {
        const aliasKey = modelKeyOf(a.alias) || normalizeKey(a.alias);
        const canonicalKey = modelKeyOf(a.canonical) || normalizeKey(a.canonical);
        if (!aliasKey || !canonicalKey || aliasKey === canonicalKey) continue;
        await c.query(
          `INSERT INTO kb_aliases (account_id, alias, alias_key, canonical, canonical_key, source_id, created_by, product_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (account_id, alias_key) DO UPDATE SET alias = EXCLUDED.alias, canonical = EXCLUDED.canonical, canonical_key = EXCLUDED.canonical_key, source_id = EXCLUDED.source_id, product_id = EXCLUDED.product_id`,
          [accountId, a.alias.trim().slice(0, 300), aliasKey, a.canonical.trim().slice(0, 300), canonicalKey, sourceId, createdBy, a.productId],
        );
        aliases += 1;
      }
      const fresh = await c.query<{ model_key: string; width_mm: number | null; height_mm: number | null }>(`SELECT model_key, width_mm, height_mm FROM kb_prices WHERE account_id = $1 AND origin = 'price_list' AND source_id = $2`, [accountId, sourceId]);
      const oldKeys = new Set(old.rows.map(key));
      const newKeys = new Set(fresh.rows.map(key));
      let removed = 0;
      for (const k of oldKeys) if (!newKeys.has(k)) removed += 1;
      let added = 0;
      for (const k of newKeys) if (!oldKeys.has(k)) added += 1;
      return { imported, replaced: del.rowCount ?? 0, was: old.rowCount ?? 0, removed, added, sizes: data.sizes.length, aliases, dictionary: data.dictionary.length };
    });
  }

  /** Сетка размеров товара (вкладка «Размеры»). */
  async sizesOfProduct(accountId: number, productId: string): Promise<KbSize[]> {
    const { rows } = await this.db.query('SELECT * FROM kb_sizes WHERE account_id = $1 AND product_id = $2 ORDER BY width_mm, height_mm', [accountId, productId]);
    return rows.map((r) => ({ id: Number(r.id), productId: String(r.product_id), sizeId: (r.size_id ?? null) as string | null, widthMm: Number(r.width_mm), heightMm: Number(r.height_mm), basis: (r.basis ?? null) as string | null, leafWidthsMm: (r.leaf_widths_mm ?? null) as number[] | null }));
  }

  /** Правило нестандарта прайса (по ключу файла); нет — значения по умолчанию из задания (30 / 30 / 100 %). */
  async ruleOf(accountId: number, priceKey: string | null): Promise<BookRule> {
    const dflt: BookRule = { largeThresholdPercent: 30, regularSurchargePercent: 30, largeSurchargePercent: 100, appliesTo: 'base', productionNote: null };
    if (!priceKey) return dflt;
    const { rows } = await this.db.query('SELECT * FROM kb_rules WHERE account_id = $1 AND price_key = $2 LIMIT 1', [accountId, priceKey]);
    const r = rows[0];
    return r ? { largeThresholdPercent: Number(r.large_threshold_percent), regularSurchargePercent: Number(r.regular_surcharge_percent), largeSurchargePercent: Number(r.large_surcharge_percent), appliesTo: String(r.applies_to), productionNote: (r.production_note ?? null) as string | null } : dflt;
  }

  /** Словарь агента (Словарь, Сокращения, ГОСТы, Типоразмеры). */
  async dictionary(accountId: number): Promise<KbDictionaryEntry[]> {
    const { rows } = await this.db.query('SELECT * FROM kb_dictionary WHERE account_id = $1 ORDER BY sheet, id', [accountId]);
    return rows.map((r) => ({ id: Number(r.id), sheet: String(r.sheet), term: String(r.term), termKey: String(r.term_key), meaning: (r.meaning ?? null) as string | null, context: (r.context ?? null) as string | null, rule: (r.rule ?? null) as string | null, sourceId: Number(r.source_id) }));
  }

  /** Счётчики файла для карточки источника: цены дверей / комплектующих / фурнитуры / размеров / синонимов / комментариев. */
  async bookCountsBySource(accountId: number): Promise<Map<number, BookCounts>> {
    const out = new Map<number, BookCounts>();
    const get = (id: number): BookCounts => {
      const cur = out.get(id);
      if (cur) return cur;
      const fresh: BookCounts = { doors: 0, components: 0, hardware: 0, sizes: 0, aliases: 0, comments: 0, dictionary: 0 };
      out.set(id, fresh);
      return fresh;
    };
    const p = await this.db.query<{ source_id: string; category: string; n: number; c: number }>(`SELECT source_id, category, count(*)::int AS n, count(*) FILTER (WHERE card->>'comment' IS NOT NULL)::int AS c FROM kb_prices WHERE account_id = $1 AND source_id IS NOT NULL GROUP BY source_id, category`, [accountId]);
    for (const r of p.rows) {
      const x = get(Number(r.source_id));
      if (r.category === 'door') x.doors += r.n;
      else if (r.category === 'component') x.components += r.n;
      else if (r.category === 'hardware') x.hardware += r.n;
      x.comments += r.c;
    }
    for (const [table, field] of [['kb_sizes', 'sizes'], ['kb_aliases', 'aliases'], ['kb_dictionary', 'dictionary']] as const) {
      const q = await this.db.query<{ source_id: string; n: number }>(`SELECT source_id, count(*)::int AS n FROM ${table} WHERE account_id = $1 AND source_id IS NOT NULL GROUP BY source_id`, [accountId]);
      for (const r of q.rows) get(Number(r.source_id))[field] += r.n;
    }
    return out;
  }

  /** Все записи происхождения (прайс для подбора по признакам и медианы группы). */
  async listByOrigin(accountId: number, origin: PriceOrigin): Promise<KbPrice[]> {
    const { rows } = await this.db.query(`${SELECT} WHERE p.account_id = $1 AND p.origin = $2 ORDER BY p.id`, [accountId, origin]);
    return rows.map(mapPrice);
  }

  /** Все строки прайса по ID товара или тарифа (дверь, её комплектующие, тариф «Дополнений»). */
  async rowsByProductId(accountId: number, productId: string): Promise<KbPrice[]> {
    const { rows } = await this.db.query(`${SELECT} WHERE p.account_id = $1 AND p.product_id = $2 ORDER BY p.valid_at DESC, p.id`, [accountId, productId]);
    return rows.map(mapPrice);
  }

  /** Строки двери по ID товара многолистового прайса (KB-PRICE-SHEETS): контекст модели для комплектующих и фурнитуры. */
  async doorsByProductId(accountId: number, productId: string): Promise<KbPrice[]> {
    const { rows } = await this.db.query(`${SELECT} WHERE p.account_id = $1 AND p.product_id = $2 AND p.category = 'door' ORDER BY p.valid_at DESC, p.id`, [accountId, productId]);
    return rows.map(mapPrice);
  }

  /** Старые записи без признаков (до KB-MATCH): признаки из текста модели, сокращения и назначения — один раз при старте. */
  async backfillFeatures(): Promise<number> {
    const { rows } = await this.db.query<{ id: string; model: string; abbr: string | null; description: string | null }>('SELECT id, model, abbr, description FROM kb_prices WHERE features IS NULL');
    for (const r of rows) {
      const f = featuresOf([r.model, r.abbr, r.description].filter(Boolean).join(' | '));
      await this.db.query('UPDATE kb_prices SET features = $2::jsonb, feature_key = $3 WHERE id = $1', [Number(r.id), JSON.stringify(f), featureKeyOf(f)]);
    }
    return rows.length;
  }

  /** Категория у записей, импортированных до KB-COMPONENTS: по тексту модели (веб-«Добор…» → комплектующее); один раз при старте. */
  async backfillCategories(): Promise<number> {
    // KB-HW-NULL-2: только строки, категорию которых никто не задавал явно (веб-цены и правки до KB-COMPONENTS); категорию из импорта
    // прайса («Дополнения» — фурнитура, лист 1 — дверь) пересчёт по словам больше не трогает.
    const { rows } = await this.db.query<{ id: string; model: string; abbr: string | null; category: string }>('SELECT id, model, abbr, category FROM kb_prices WHERE NOT category_fixed');
    let n = 0;
    for (const r of rows) {
      const cat = categoryOf([r.model, r.abbr].filter(Boolean).join(' '));
      if (cat === r.category) continue;
      await this.db.query('UPDATE kb_prices SET category = $2, component_kind = $3 WHERE id = $1', [Number(r.id), cat, cat === 'component' ? componentKindOf(r.model) : null]);
      n += 1;
    }
    return n;
  }

  /** Сколько цен у каждого источника — для карточки источника («цен 12»). */
  async countBySource(accountId: number): Promise<Map<number, number>> {
    const { rows } = await this.db.query<{ source_id: string; n: number }>('SELECT source_id, count(*)::int AS n FROM kb_prices WHERE account_id = $1 AND source_id IS NOT NULL GROUP BY source_id', [accountId]);
    return new Map(rows.map((r) => [Number(r.source_id), r.n]));
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
      `UPDATE kb_prices SET model = $3, model_key = $4, factory = $5, unit = $6, base_size = $7, width_mm = $8, height_mm = $9, price = $10, vat = $11, valid_at = $12, confidence = $13, nonstandard = $14::jsonb, url = $15, note = $16, search_tokens = $17::text[], updated_at = now()
        WHERE account_id = $1 AND id = $2`,
      [accountId, id, model.trim().slice(0, 300), modelKeyOf(model) || normalizeKey(model), (patch.factory === undefined ? cur.factory : patch.factory)?.trim() || null, patch.unit ?? cur.unit, sizeLabel(width, height), width, height, patch.price ?? cur.price, patch.vat ?? cur.vat, patch.validAt ?? cur.validAt, patch.confidence ?? cur.confidence, JSON.stringify(patch.nonstandard ?? cur.nonstandard), patch.url === undefined ? cur.url : patch.url, patch.note === undefined ? cur.note : patch.note, searchTokensOf(model, cur.abbr, cur.description)],
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

  /**
   * Кандидаты по ключам модели: точные (ключ модели или ключи сокращения/назначения), модель базы целиком внутри названия
   * позиции («турин» в «браво турин белая эмаль»), похожие по триграммам (≥ 0.55), а также записи, с которыми у позиции
   * есть хотя бы два общих слова подбора (KB-PRICELIST, г) — их вес считает lookupPrice.
   */
  async candidates(accountId: number, keys: string[], tokens: string[] = []): Promise<{ row: KbPrice; similarity: number; overlap: number }[]> {
    const list = [...new Set(keys.filter(Boolean))];
    if (!list.length) return [];
    const sim = `GREATEST(${list.map((_, i) => `similarity(p.model_key, $${i + 2}::text)`).join(', ')})`;
    // Модель базы внутри названия позиции или название позиции внутри модели базы («турин» ↔ «браво турин»).
    const inside = list.map((_, i) => `(position(' ' || p.model_key || ' ' in ' ' || $${i + 2}::text || ' ') > 0 OR position(' ' || $${i + 2}::text || ' ' in ' ' || p.model_key || ' ') > 0)`).join(' OR ');
    const keysParam = list.length + 2;
    const tokensParam = list.length + 3;
    // Коррелированная ссылка на p допустима в списке выборки подзапроса, но не в его FROM.
    const overlap = `cardinality(ARRAY(SELECT unnest(p.search_tokens) INTERSECT SELECT unnest($${tokensParam}::text[])))`;
    const minOverlap = tokens.length >= 2 ? 2 : 1;
    const { rows } = await this.db.query(
      `${SELECT}, ${sim} AS sim, ${overlap} AS overlap
        WHERE p.account_id = $1 AND (p.model_key = ANY($${keysParam}::text[]) OR p.alt_keys && $${keysParam}::text[] OR ${inside} OR ${sim} >= 0.55 OR (cardinality($${tokensParam}::text[]) > 0 AND ${overlap} >= ${minOverlap}))
        ORDER BY sim DESC, overlap DESC, p.confidence DESC, p.valid_at DESC LIMIT 60`,
      [accountId, ...list, list, tokens],
    );
    return rows.map((r) => ({ row: mapPrice(r), similarity: Number(r.sim ?? 0), overlap: Number(r.overlap ?? 0) }));
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
  async resolve(accountId: number, key: string): Promise<{ canonical: string; canonicalKey: string; keys: string[]; productId: string | null } | null> {
    if (!key) return null;
    const { rows } = await this.db.query('SELECT * FROM kb_aliases WHERE account_id = $1 AND (alias_key = $2 OR canonical_key = $2) LIMIT 1', [accountId, key]);
    const hit = rows[0] ? mapAlias(rows[0]) : null;
    if (!hit) return null;
    const all = await this.db.query<{ alias_key: string }>('SELECT alias_key FROM kb_aliases WHERE account_id = $1 AND canonical_key = $2', [accountId, hit.canonicalKey]);
    return { canonical: hit.canonical, canonicalKey: hit.canonicalKey, keys: [...new Set([hit.canonicalKey, ...all.rows.map((r) => r.alias_key)])], productId: hit.aliasKey === key ? hit.productId ?? null : null };
  }

  /**
   * KB-PRICE-SHEETS-FIX, п. 7а: синоним прайса внутри длинного названия позиции («Дверной блок, деревянный, внутренний, глухой,
   * однопольный, … ДВ 1Рп 2100-10 Г ПрБ …» содержит все слова синонима «ДВ 1Рп Г ПрБ» → INT-013). Берётся самый длинный
   * синоним с ID товара, все слова которого есть среди слов позиции; синонимы из одного слова короче четырёх букв не считаются.
   */
  async resolveInText(accountId: number, tokens: string[]): Promise<{ canonical: string; canonicalKey: string; keys: string[]; productId: string } | null> {
    const words = [...new Set(tokens.filter(Boolean))];
    if (!words.length) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM kb_aliases WHERE account_id = $1 AND product_id IS NOT NULL AND string_to_array(alias_key, ' ') <@ $2::text[]
       ORDER BY cardinality(string_to_array(alias_key, ' ')) DESC, length(alias_key) DESC LIMIT 20`,
      [accountId, words],
    );
    const hit = rows.map(mapAlias).find((a) => a.aliasKey.split(' ').length >= 2 || a.aliasKey.length >= 4 || /\d/.test(a.aliasKey));
    if (!hit || !hit.productId) return null;
    const all = await this.db.query<{ alias_key: string }>('SELECT alias_key FROM kb_aliases WHERE account_id = $1 AND canonical_key = $2', [accountId, hit.canonicalKey]);
    return { canonical: hit.canonical, canonicalKey: hit.canonicalKey, keys: [...new Set([hit.canonicalKey, ...all.rows.map((r) => r.alias_key)])], productId: hit.productId };
  }
}

/** Семейство двери по тексту позиции (KB-PRICE-SHEETS-FIX, п. 7б): деревянная / межкомнатная — interior, стальная — steel, алюминиевая — aluminium. */
export function familyOfText(text: string): Family | null {
  const t = ` ${text.toLowerCase().replace(/ё/g, 'е')} `;
  if (/алюмини/.test(t)) return 'aluminium';
  if (/стальн|\sсталь|металлическ|\sметалл\s|железн/.test(t)) return 'steel';
  if (/деревянн|межкомнатн|мдф|\scpl|cpl\s|\sпвх|шпон|экошпон|ламинир|ламинат|эмал|массив/.test(t)) return 'interior';
  return null;
}

/** Семейство строки базы: из многолистового прайса — как в файле; у остальных — по материалу признаков. */
export function familyOfRow(row: Pick<KbPrice, 'family' | 'features' | 'model' | 'abbr' | 'description'>): Family | null {
  if (row.family) return row.family;
  const m = rowFeatures(row).material;
  return m === 'wood' ? 'interior' : m === 'steel' ? 'steel' : m === 'aluminium' ? 'aluminium' : null;
}

/** Что ищем в базе цен: позиция заявки. */
export interface PriceQuery {
  name: string;
  raw?: string;
  widthMm?: number | null;
  heightMm?: number | null;
  leaves?: number | null;
  thicknessMm?: number | null;
  /** Признаки позиции от модели разбора письма (KB-MATCH); из текста извлекаются всегда, явные — сверху. */
  features?: Partial<DoorFeatures> | null;
  /** Категория позиции (KB-COMPONENTS); не задана — по тексту. Подбор идёт только среди записей своей категории. */
  category?: PositionCategory | null;
  /**
   * KB-PRICE-SHEETS: ID товара двери, к которой относится комплектующее или фурнитура (ближайшая дверь заявки выше):
   * статусы «включена» / «нет цены» берутся из карточки этой двери, комплектующие — её строки, фурнитура — по «Для моделей».
   */
  doorProductId?: string | null;
  /** Смета: допускаются позиции со статусом inactive / estimate_only и при подборе по признакам (иначе — только по точному ключу или синониму). */
  estimate?: boolean;
  /** Основание размера в заявке (проём / полотно / блок / пара); расходится с прайсом — пересчёта нет, вопрос менеджеру. */
  sizeBasis?: UnitBasis | null;
  /** KB-DOOR-MATCH-2: ID товара, уже выбранный для такой же строки заявки — одинаковые строки получают один ID. */
  productId?: string | null;
}

/**
 * Особые исполнения, которые нельзя заменять похожей моделью (Задача_Клауду, стр. 28: «ДПГУЧ 52 мм с обратной четвертью и
 * АКВА 01 ПГ не заменять обычной ДПГ»): позиция с таким кодом подбирается только к строке прайса, где этот код есть.
 */
export const SPECIAL_MODELS: { code: RegExp; title: string }[] = [
  { code: /дпгуч/, title: 'ДПГУЧ' },
  { code: /аква/, title: 'Аква' },
];
export function specialModelOf(text: string): { code: RegExp; title: string } | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  return SPECIAL_MODELS.find((m) => m.code.test(t)) ?? null;
}

/** Особое исполнение строки прайса двери: противопожарная, двустворчатая, влагостойкая (санузловая), раздвижная. */
function specialOfRow(row: KbPrice): { fire: boolean; pair: boolean; wet: boolean; sliding: boolean } {
  const rf = rowFeatures(row);
  const t = ` ${[row.model, row.abbr, row.description, row.card?.comment ?? ''].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е')} `;
  return {
    fire: Boolean(rf.fire) || /(?<![a-zа-я])(ei|е|e)[\s-]?(15|30|45|60|90)(?![0-9])|противопож|огнестойк/.test(t),
    pair: rf.leaves === 2 || row.card?.leafCount === 2 || /двухствор|двуствор|двупол|2 полотн/.test(t),
    // «ДС» — санузловой блок только у межкомнатных; в металлическом прайсе ДС — «дверь стальная».
    wet: /влагост|санузл/.test(t) || (familyOfRow(row) === 'interior' && /(?<![a-zа-я])дс(?![a-zа-я])/.test(` ${(row.abbr ?? '').toLowerCase()} `)),
    sliding: /раздвиж|купе(?![a-zа-я])/.test(t),
  };
}

/** То же по тексту позиции: особое исполнение подбирается, только если оно названо в заявке. */
function specialOfQuery(text: string, qf: DoorFeatures): { fire: boolean; pair: boolean; wet: boolean; wetCode: boolean; sliding: boolean } {
  const t = ` ${text.toLowerCase().replace(/ё/g, 'е')} `;
  return {
    fire: Boolean(qf.fire) || /(?<![a-zа-я])(ei|е|e)[\s-]?(15|30|45|60|90)(?![0-9])|противопож|огнестойк|(?<![a-zа-я])ддп/.test(t),
    pair: qf.leaves === 2 || /двухствор|двуствор|двупол|2 полотн|две створ/.test(t),
    wet: /влагост|санузл/.test(t),
    // «ДС» в позиции — санузловой блок только для межкомнатных строк (см. specialOfRow).
    wetCode: /(?<![a-zа-я])дс(?![a-zа-я])/.test(t),
    sliding: /раздвиж|купе(?![a-zа-я])/.test(t),
  };
}

export interface PriceHit {
  row: KbPrice;
  /** Цена за единицу позиции после правил; null — при outcome = not_priced (в прайсе цены нет) и included (входит в цену блока, не 0 ₽). */
  price: number | null;
  /** exact — модель и размер совпали; rules — правила нестандарта; area — пересчёт по площади; base — размер в прайсе не указан. */
  basis: 'exact' | 'rules' | 'area' | 'base';
  /** Совпадение: по признакам (KB-MATCH), точное (ключ модели, сокращения или назначения), по синониму, по вхождению слов, по похожести, по общим словам. */
  match: 'features' | 'exact' | 'alias' | 'tokens' | 'similar' | 'words';
  similarity: number;
  /** Подбор по признакам: что совпало и признаки позиции. */
  features?: { matched: FeatureKey[]; query: DoorFeatures } | null;
  /** Доверие записи; при подборе по словам — снижено пропорционально совпадению. */
  confidence: number;
  /** Срок актуальности вышел — цена ставится с пометкой «цена устарела». */
  stale: boolean;
  validityDays: number;
  notes: string[];
  /** Подпись для плитки: «по базе: прайс Текона (01.10.2026)», «по закупке», «по рынку (кэш 05.10.2026)», «изменено менеджером». */
  label: string;
  /**
   * KB-PRICE-SHEETS: priced — своя цена; included — входит в цену блока двери (price 0, в таблицу КП отдельной суммой не идёт);
   * not_priced — в прайсе цены нет («уточнить у менеджера», не 0 ₽); estimate — сметная цена или позиция только для сметы.
   */
  outcome?: 'priced' | 'included' | 'not_priced' | 'estimate';
  /** Примечания к КП из вкладки «Подбор» — под позицией в документе. */
  quoteNotes?: string[];
  /** outcome = included: ID двери, в цену блока которой входит позиция (или название комплекта — ставит вызывающий). */
  includedIn?: string | null;
  /** KB-DOOR-MATCH-2: позиция одинаково подходит к нескольким моделям прайса — их ID; строка прайса (row) не выбрана. */
  ambiguous?: string[];
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

/** У записи есть цена (KB-HW-NULL: тариф «Дополнений» без цены хранится как NULL, а не 0). */
export const hasPrice = <T extends { price: number | null }>(row: T): row is T & { price: number } => row.price !== null && row.price > 0;

/** Цена строки по правилам нестандарта относительно базового размера записи прайса; у записи без цены — null. */
export function applyRules(row: KbPrice, q: PriceQuery): { price: number | null; basis: PriceHit['basis']; notes: string[] } {
  if (!hasPrice(row)) return { price: null, basis: 'base', notes: [] };
  return applyRulesPriced({ ...row, price: row.price }, q);
}

function applyRulesPriced(row: KbPrice & { price: number }, q: PriceQuery): { price: number; basis: PriceHit['basis']; notes: string[] } {
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

/** Признаки строки базы: сохранённые или извлечённые из текста модели, сокращения и назначения (старые записи). */
export function rowFeatures(row: Pick<KbPrice, 'features' | 'model' | 'abbr' | 'description'>): DoorFeatures {
  return row.features ?? featuresOf([row.model, row.abbr, row.description].filter(Boolean).join(' | '));
}

type Candidate = { row: KbPrice; match: PriceHit['match']; similarity: number; words: number; features: FeatureMatch | null };

/** Совпадение строки базы с позицией по ключам модели (как до KB-MATCH): точное, синоним, слова, похожесть, общие слова. */
function keyMatch(row: KbPrice, key: string, alias: { keys: string[] } | null, itemTokens: Set<string>, qSet: Set<string>, similarity: number): { match: PriceHit['match']; words: number } | null {
  if (!key) return null;
  if (row.modelKey === key || row.altKeys.includes(key)) return { match: 'exact', words: 0 };
  if (alias && alias.keys.some((k) => k === row.modelKey || row.altKeys.includes(k))) return { match: 'alias', words: 0 };
  const t = tokensOf(row.modelKey);
  // Все слова модели из базы есть в позиции: «Турин» внутри «Браво Турин белая эмаль». Одно слово — только если это
  // не цвет/отделка и оно длиннее трёх букв (или артикул с цифрой).
  const single = t.length === 1 && (/\d/.test(t[0] ?? '') || ((t[0]?.length ?? 0) >= 4 && !FINISH_WORDS.has(t[0] ?? '')));
  if (t.length && t.every((x) => itemTokens.has(x)) && (t.length >= 2 || single)) return { match: 'tokens', words: 0 };
  // Обратное вхождение: короткое название позиции («турин») целиком внутри модели базы («браво турин»).
  const it = [...itemTokens];
  const significant = it.length === 1 ? /\d/.test(it[0] ?? '') || ((it[0]?.length ?? 0) >= 4 && !FINISH_WORDS.has(it[0] ?? '')) : it.length >= 2;
  const rowTokens = new Set(t);
  if (it.length && significant && it.every((x) => rowTokens.has(x))) return { match: 'tokens', words: 0 };
  if (similarity >= 0.7) return { match: 'similar', words: 0 };
  // Подбор по словам: доля общих слов подбора (Жаккар) между позицией и записью прайса (модель + сокращение + назначение).
  const words = wordsScore(qSet, row.searchTokens);
  return words >= WORDS_MIN ? { match: 'words', words } : null;
}

/**
 * Подбор цены из базы для позиции (KB-MATCH):
 *  1. строки прайса по признакам (тип, материал, глухая/остеклённая, створки, порог, открывание, покрытие,
 *     огнестойкость, доводчик, замок): обязательные не расходятся, совпало не меньше двух;
 *  2. остальные совпадения по ключам модели (точное, синоним, слова, похожесть, общие слова) для всех происхождений;
 *     при известных признаках строка с расхождением по обязательному признаку отвергается;
 *  3. порядок источников: прайс → закупка → правка менеджера → веб: веб-запись никогда не перебивает подходящую
 *     строку прайса; веб-цены вне 40–300 % медианы прайса по группе признаков отбрасываются;
 *  4. внутри источника: подходит по признакам › точный ключ или синоним › балл признаков › остальные совпадения
 *     (слова › похожесть › общие слова) › размер (точный › правила нестандарта › площадь › базовая) › доверие ›
 *     близость площади › свежесть.
 */
export async function lookupPrice(prices: KbPricesRepo, aliases: KbAliasesRepo, accountId: number, query: PriceQuery, now = new Date()): Promise<PriceHit | null> {
  // KB-DOOR-MATCH-2, п. 1: «кромка ПВХ …» не участвует ни в ключе модели, ни в словах, ни в признаках.
  const q: PriceQuery = { ...query, name: withoutEdge(query.name).replace(/\s+/g, ' ').replace(/[\s,;|/]+$/, '').trim() || query.name, raw: query.raw ? withoutEdge(query.raw) : query.raw };
  const text = `${q.name} ${q.raw ?? ''}`;
  const key = modelKeyOf(q.name) || modelKeyOf(text);
  const qf = mergeFeatures(featuresOf(text), q.features);
  // KB-COMPONENTS: работы цены не ищут; остальные — только среди записей своей категории (комплектующие — своего вида).
  let category: PositionCategory = q.category ?? categoryOf(text);
  if (category === 'service') return null;
  // Синоним целиком или синоним с ID товара внутри длинного названия (п. 7а).
  const exactAlias = key ? await aliases.resolve(accountId, key) : null;
  const inText = exactAlias ? null : await aliases.resolveInText(accountId, tokensOf(key));
  const alias = exactAlias ?? inText;
  const namedProductId = q.productId ?? exactAlias?.productId ?? inText?.productId ?? null;
  // KB-PRICE-SHEETS: синоним или точный ключ из прайса ведёт в другую категорию (вкладка «Дополнения»: «Фрамуга» — фурнитура,
  // а по словам позиция считалась дверью) — категория позиции берётся из найденной строки.
  // Синоним с ID тарифа внутри названия («СПД40 … для алюминиевой двери» → OPT-012): позиция — фурнитура, а не дверь по умолчанию.
  const namedRows = namedProductId ? await prices.rowsByProductId(accountId, namedProductId) : [];
  if (category === 'door' && namedRows.length && !namedRows.some((r) => r.category === 'door')) category = (namedRows[0] as KbPrice).category;
  if (category === 'door' && key) {
    const exact = (await prices.candidates(accountId, alias ? [key, ...alias.keys] : [key], [])).filter((f) => f.row.modelKey === key || f.row.altKeys.includes(key) || (alias?.keys ?? []).some((k) => k === f.row.modelKey || f.row.altKeys.includes(k)));
    const other = exact.find((f) => f.row.category === 'hardware') ?? exact[0];
    if (other && !exact.some((f) => f.row.category === 'door')) category = other.row.category;
  }
  const componentKind = category === 'component' ? componentKindOf(text) : null;
  const sameCategory = (row: KbPrice) => row.category === category && (category !== 'component' || !componentKind || !row.componentKind || row.componentKind === componentKind);
  const size = { widthMm: q.widthMm ?? sizeOf(text)?.widthMm ?? null, heightMm: q.heightMm ?? sizeOf(text)?.heightMm ?? null };
  const leaves = q.leaves ?? qf.leaves ?? leavesOf(text);
  // KB-PRICE-SHEETS: дверь-контекст для комплектующего / фурнитуры — статусы из карточки двери решают до подбора.
  const door = q.doorProductId && category !== 'door' ? ((await prices.doorsByProductId(accountId, q.doorProductId))[0] ?? null) : null;
  if (door && category === 'component' && componentKind) {
    const st = door.componentStatus?.[componentKind] ?? null;
    if (st === 'included') return doorOutcome(door, 'included', [`${componentKind} входит в цену блока ${door.model}${door.card?.baseIncludes ? ` (в базу входит: ${door.card.baseIncludes})` : ''}`], now);
    if (st === 'not_priced') return doorOutcome(door, 'not_priced', [`уточнить у менеджера: ${componentKind} к ${door.model} в прайсе без цены`], now);
  }
  // KB-COMPONENT-DOOR: комплектующее из колонки прайса дверей («Коробка (ДПГ CPL)») — только по своей двери (componentOfDoor);
  // без двери такие строки не подбираются: «первая / самая дешёвая строка» другой двери запрещена.
  const doorBound = (row: KbPrice) => row.origin === 'price_list' && row.category === 'component' && Boolean(row.productId || row.description?.startsWith('комплектующее к '));
  const banDoorBound = category === 'component' && !door;
  const keys = key ? (alias ? [key, ...alias.keys] : [key]) : [];
  const queryTokens = searchTokensOf(q.name, q.raw);
  // KB-WEB-ROWS: цена в КП — только из прайсов. Строки базы из веб-поиска, правок менеджера и закупки остаются в базе,
  // но в подбор не идут: без строки прайса позиция — «уточнить у менеджера».
  const found = (keys.length ? await prices.candidates(accountId, keys, queryTokens) : []).filter((f) => f.row.origin === 'price_list' && sameCategory(f.row));
  const priceList = (await prices.listByOrigin(accountId, 'price_list')).filter(sameCategory);
  const cands: Candidate[] = [];
  const seen = new Set<number>();
  const itemTokens = new Set(tokensOf(key));
  const qSet = new Set(queryTokens);
  const byId = new Map(found.map((f) => [f.row.id, f]));
  // Статусы прайса: inactive / estimate_only — только в смете или когда позиция названа прямо (точный ключ или синоним);
  // фурнитура без цены (price 0) остаётся видимой — менеджер увидит «уточнить», а не веб-цену.
  // Тариф без цены (price NULL) остаётся видимым — менеджер увидит «уточнить у менеджера», а не веб-цену и не 0 ₽.
  const allowed = (row: KbPrice, match: PriceHit['match'] | null) => row.status === 'active' || Boolean(q.estimate) || (row.category === 'hardware' && !hasPrice(row)) || match === 'exact' || match === 'alias';
  // Семейство (п. 7б): деревянная дверь письма не подбирается к стальной или алюминиевой строке и наоборот; покрытие письма (п. 7в) —
  // обязательный признак: строка двери с другим покрытием в колонке прайса не подходит. Названная синонимом модель — вне этих правил.
  const qFamily = category === 'door' ? familyOfText(text) : null;
  const named = (row: KbPrice) => Boolean(namedProductId && row.productId === namedProductId);
  // KB-DOOR-MATCH-2: противопожарная (EI / Е-30 / ДДП), двустворчатая, влагостойкая (санузловой блок ДС) и раздвижная строки прайса —
  // только если это исполнение названо в позиции; код особого исполнения (ДПГУЧ, Аква) — только к строке, где он есть.
  const qSpecial = category === 'door' ? specialOfQuery(text, qf) : null;
  const special = category === 'door' ? specialModelOf(text) : null;
  // KP-AGENT-V2, п. 3.2: подбор двери — по ГОСТ-профилю: ГОСТ, вид, створки, Г/О, огнестойкость не должны расходиться.
  const qProfile = category === 'door' ? profileOf(text) : null;
  const rowProfiles = new Map<number, GostProfile>();
  const rowProfile = (row: KbPrice) => rowProfiles.get(row.id) ?? (rowProfiles.set(row.id, profileOfRow(row)), rowProfiles.get(row.id) as GostProfile);
  const fits = (row: KbPrice) => {
    if (row.category !== 'door' || named(row)) return true;
    if (qProfile && profileConflicts(qProfile, rowProfile(row)).length) return false;
    const rf = qFamily ? familyOfRow(row) : null;
    if (qFamily && rf && rf !== qFamily) return false;
    if (qf.coating && row.coating && rowFeatures(row).coating !== qf.coating) return false;
    if (qSpecial) {
      const rs = specialOfRow(row);
      // В обе стороны: обычная позиция не берёт особое исполнение, позиция с особым исполнением — обычную строку.
      const qWet = qSpecial.wet || (qSpecial.wetCode && familyOfRow(row) === 'interior');
      if (rs.fire !== qSpecial.fire || rs.pair !== qSpecial.pair || rs.wet !== qWet || rs.sliding !== qSpecial.sliding) return false;
    }
    if (special && !special.code.test([row.model, row.abbr, ...row.altKeys].filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е'))) return false;
    return true;
  };
  // Фурнитура «Для моделей»: при известной двери — только подходящая ей; без двери — любая, с пометкой.
  const forDoor = (row: KbPrice) => !(row.category === 'hardware' && row.appliesTo.length && q.doorProductId && !row.appliesTo.includes(q.doorProductId));
  // Строки прайса: совпадение по признакам; если строка нашлась и по ключу модели — ключ остаётся видом совпадения,
  // признаки прилагаются (ранжирование: подходит по признакам › точный ключ › балл признаков).
  if (hasFeatures(qf) || category === 'component') {
    for (const row of priceList) {
      if (!fits(row) || (banDoorBound && doorBound(row))) continue;
      const fm = matchFeatures(qf, rowFeatures(row));
      // Комплектующее того же вида (добор, коробка…) подходит и без общих признаков двери: лишь бы обязательные не расходились.
      const ok = category === 'component' ? fm.conflict === null && Boolean(componentKind) && row.componentKind === componentKind : fm.ok;
      if (!ok) continue;
      const f = byId.get(row.id);
      const m = f ? keyMatch(row, key, alias, itemTokens, qSet, f.similarity) : null;
      if (!allowed(row, m?.match ?? null)) continue;
      cands.push({ row, match: m?.match ?? 'features', similarity: f?.similarity ?? 0, words: m?.words ?? 0, features: fm });
      seen.add(row.id);
    }
  }
  for (const { row, similarity } of found) {
    if (seen.has(row.id) || !fits(row) || (banDoorBound && doorBound(row))) continue;
    const m = keyMatch(row, key, alias, itemTokens, qSet, similarity);
    if (!m || !allowed(row, m.match)) continue;
    const rf = rowFeatures(row);
    // Точный ключ или синоним — модель названа прямо, расхождение признаков её не отвергает (KB-PRICE-SHEETS: «ДПГ сота с коробкой» = INT-008).
    if (m.match !== 'exact' && m.match !== 'alias' && hasFeatures(qf) && hasFeatures(rf) && matchFeatures(qf, rf).conflict) continue;
    cands.push({ row, match: m.match, similarity, words: m.words, features: null });
    seen.add(row.id);
  }
  // Модель названа синонимом с ID товара, но её строки не попали в кандидаты (другая категория по словам, расхождение признаков) — добавить.
  if (namedProductId && !cands.some((c) => named(c.row))) {
    for (const row of namedRows.filter((r) => r.category === category && r.origin === 'price_list' && !(r.category === 'component' && componentKind && r.componentKind !== componentKind))) {
      if (seen.has(row.id)) continue;
      cands.push({ row, match: 'alias', similarity: 1, words: 0, features: null });
      seen.add(row.id);
    }
  }
  if (!cands.length) return null;
  // «Для моделей»: при известной двери — только подходящая ей фурнитура; подходящей нет, а позиция в прайсе есть — строка прайса с
  // пометкой менеджеру, а не веб-поиск (KB-HW-NULL: «Петля IN4000U» для INT-016/018/008 при двери INT-013).
  const fitting = cands.filter((c) => forDoor(c.row));
  const otherModels = fitting.length === 0 && category === 'hardware' && Boolean(q.doorProductId);
  if (fitting.length) cands.splice(0, cands.length, ...fitting);
  // Комплектующее к известной двери: строки её модели («Коробка (ДВ CPL)») в приоритете перед остальными (п. 6 задания).
  const own = door && category === 'component' ? cands.filter((c) => c.row.productId === door.productId) : [];
  const pool = own.length ? own : cands;
  const group = pool.filter((c) => c.row.origin === 'price_list');
  if (!group.length) return null;
  const MATCH_RANK: Record<PriceHit['match'], number> = { exact: 0, alias: 1, tokens: 2, similar: 3, words: 4, features: 5 };
  const BASIS_RANK: Record<PriceHit['basis'], number> = { exact: 0, rules: 1, area: 2, base: 3 };
  const area = size.widthMm && size.heightMm ? size.widthMm * size.heightMm : null;
  const closeness = (r: KbPrice) => (area && r.widthMm && r.heightMm ? Math.abs(Math.log((r.widthMm * r.heightMm) / area)) : 1);
  const strongKey = (c: Candidate) => (c.match === 'exact' || c.match === 'alias' ? 0 : 1);
  // Модель прайса названа в заявке целиком («ДПГ сота с коробкой» = INT-008): такая строка выше подбора по признакам.
  // Сколько слов модели строки прайса (без отделки и общих слов) есть в позиции: «ДПГ усиленная» в «ДПГ усиленная ПВХ» — 2, «ДПГ ПВХ» — 1.
  const coverCache = new Map<number, number>();
  const cover = (c: Candidate): number => {
    const hit = coverCache.get(c.row.id);
    if (hit !== undefined) return hit;
    const mw = tokensOf(c.row.modelKey).filter((w) => !FINISH_WORDS.has(w) && !/^(cpl|пвх|шпон|экошпон|эмаль|мдф)$/.test(w));
    const n = mw.filter((w) => itemTokens.has(w)).length;
    coverCache.set(c.row.id, n);
    return n;
  };
  const namedModel = (c: Candidate) => (c.row.origin === 'price_list' && ((c.match === 'exact' && c.row.modelKey === key) || (c.match === 'alias' && named(c.row))) ? 0 : 1);
  // Цена строки по размеру: строки многолистового прайса — по сетке размеров модели и правилу файла; прочие — по правилам записи.
  const sizesCache = new Map<string, Promise<KbSize[]>>();
  const rulesCache = new Map<string, Promise<BookRule>>();
  const appliedOf = async (row: KbPrice): Promise<{ price: number | null; basis: PriceHit['basis']; notes: string[] }> => {
    if (!row.productId || row.category !== 'door' || !hasPrice(row)) {
      const r = applyRules(row, { ...q, ...size, leaves });
      // Фурнитура и комплектующие без размера — обычное дело, пометка «размер не указан» нужна только дверям.
      return row.category === 'door' ? r : { ...r, notes: r.notes.filter((n) => n !== 'размер позиции не указан — базовая цена') };
    }
    const pid = row.productId;
    let sizesP = sizesCache.get(pid);
    if (!sizesP) sizesCache.set(pid, (sizesP = prices.sizesOfProduct(accountId, pid)));
    const sizes = await sizesP;
    const rk = row.priceKey ?? '';
    let ruleP = rulesCache.get(rk);
    if (!ruleP) rulesCache.set(rk, (ruleP = prices.ruleOf(accountId, row.priceKey)));
    const rule = await ruleP;
    const card = row.card;
    const notes: string[] = [];
    if (size.widthMm !== null && size.heightMm !== null && sizes.length) {
      if (q.sizeBasis && card?.sizeBasis && q.sizeBasis !== card.sizeBasis) {
        notes.push(`размер в заявке по ${BASIS_NAME[q.sizeBasis]}, в прайсе по ${BASIS_NAME[card.sizeBasis]} — пересчёт не делается, уточнить у менеджера`);
        return { price: row.price as number, basis: 'base', notes };
      }
      if (!card?.sizeBasis) notes.push('основание размера в прайсе не указано (проём / полотно / блок) — уточнить у менеджера');
    }
    const ns = nonstandardBySizes(sizes, size, rule, card?.geometry ?? null, Boolean(rowFeatures(row).fire || qf.fire));
    return { price: round2((row.price as number) * ns.factor), basis: ns.basis, notes: [...notes, ...ns.notes] };
  };
  const applied = new Map<number, Awaited<ReturnType<typeof appliedOf>>>();
  for (const c of group) applied.set(c.row.id, await appliedOf(c.row));
  const ranked = group
    .map((c) => ({ ...c, applied: applied.get(c.row.id) as Awaited<ReturnType<typeof appliedOf>> }))
    .sort(
      (a, b) =>
        namedModel(a) - namedModel(b) ||
        Number(Boolean(b.features)) - Number(Boolean(a.features)) ||
        strongKey(a) - strongKey(b) ||
        cover(b) - cover(a) ||
        (b.features?.score ?? 0) - (a.features?.score ?? 0) ||
        MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
        // У многолистового прайса размер — сетка одной модели, а не признак другой модели: одинаковые строки заявки разного
        // размера не расходятся по разным ID (KB-DOOR-MATCH-2, п. 4).
        (a.row.productId && b.row.productId ? 0 : BASIS_RANK[a.applied.basis] - BASIS_RANK[b.applied.basis]) ||
        b.words - a.words ||
        b.row.confidence - a.row.confidence ||
        closeness(a.row) - closeness(b.row) ||
        (category === 'component' ? (a.row.price ?? Number.MAX_SAFE_INTEGER) - (b.row.price ?? Number.MAX_SAFE_INTEGER) : 0) ||
        // При полностью равном совпадении строка с ценой — раньше строки без цены.
        Number(!hasPrice(a.row)) - Number(!hasPrice(b.row)) ||
        b.row.validAt.getTime() - a.row.validAt.getTime(),
    );
  let best = ranked[0] as (typeof ranked)[number];
  // KB-DOOR-MATCH-2, п. 2–3 (Задача_Клауду, стр. 17–18: «ДПГ и ДПО могут быть неоднозначны; при нескольких моделях уточнить
  // различающий признак»): дверь не названа ни моделью, ни синонимом, а по признакам и словам одинаково подходят несколько
  // моделей прайса — цену не ставим, спрашиваем менеджера; «первая подходящая» не берётся.
  if (category === 'door' && best.row.origin === 'price_list' && best.row.productId && !named(best.row) && strongKey(best) !== 0 && namedModel(best) !== 0) {
    const tie = (c: (typeof ranked)[number]) =>
      c.row.origin === 'price_list' && Boolean(c.row.productId) && namedModel(c) === namedModel(best) && Boolean(c.features) === Boolean(best.features) && strongKey(c) === strongKey(best) && cover(c) === cover(best) && (c.features?.score ?? 0) === (best.features?.score ?? 0) && MATCH_RANK[c.match] === MATCH_RANK[best.match];
    const models = [...new Map(ranked.filter(tie).map((c) => [c.row.productId as string, c.row])).values()];
    if (models.length >= 2) {
      const list = models.slice(0, 5).map((r) => `${r.productId} «${r.model}»`).join(', ');
      const note = `уточнить у менеджера: «${q.name.trim()}» подходит к нескольким моделям прайса: ${list}${models.length > 5 ? ` и ещё ${models.length - 5}` : ''} — нужен различающий признак (модель, покрытие, исполнение)`;
      return { row: best.row, price: null, basis: 'base', match: best.match, similarity: best.similarity, confidence: best.row.confidence, stale: false, validityDays: validityDaysOf(best.row), notes: [note], label: 'несколько моделей в прайсе', features: null, outcome: 'not_priced', quoteNotes: [], includedIn: null, ambiguous: models.map((r) => r.productId as string) };
    }
  }
  // KB-MULTIPRICE, п. 3: одинаково подходящие строки в двух прайсах-файлах — берётся более свежая, менеджеру пометка.
  const twoLists: string[] = [];
  if (best.row.origin === 'price_list') {
    const same = (c: (typeof ranked)[number]) =>
      namedModel(c) === namedModel(best) && Boolean(c.features) === Boolean(best.features) && strongKey(c) === strongKey(best) && (c.features?.score ?? 0) === (best.features?.score ?? 0) && MATCH_RANK[c.match] === MATCH_RANK[best.match] && BASIS_RANK[c.applied.basis] === BASIS_RANK[best.applied.basis];
    const ties = ranked.filter((c) => c.row.origin === 'price_list' && same(c));
    const bySource = new Map<number, (typeof ranked)[number]>();
    for (const c of ties) {
      const sid = c.row.sourceId ?? 0;
      const prev = bySource.get(sid);
      if (!prev || c.row.validAt.getTime() > prev.row.validAt.getTime()) bySource.set(sid, c);
    }
    if (bySource.size >= 2) {
      const lists = [...bySource.values()].sort((a, b) => b.row.validAt.getTime() - a.row.validAt.getTime() || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
      best = lists[0] as (typeof ranked)[number];
      // KB-PRICE-SHEETS: один тариф фурнитуры в двух файлах (цены сверены при импорте) — не «два прайса», а та же строка.
      const sameTariff = lists.every((c) => c.row.tariffId && c.row.tariffId === lists[0]?.row.tariffId);
      if (!sameTariff) twoLists.push(...lists.map((c) => `«${c.row.priceTitle || c.row.sourceTitle || c.row.model}» (${c.row.validAt.toLocaleDateString('ru-RU')})`));
    }
  }
  const bestApplied = best.applied;
  const validityDays = validityDaysOf(best.row);
  const stale = now.getTime() - best.row.validAt.getTime() > validityDays * 86_400_000;
  const notes = [...bestApplied.notes];
  const where = best.row.sourceRow ? ` (строка ${best.row.sourceRow})` : '';
  let label = priceLabelOf(best.row);
  if (best.features && category === 'component') {
    // Комплектующее из колонки прайса дверей: к какой модели двери относится цена, менеджер видит в пометке.
    label = `по прайсу: ${best.row.model}${where}`;
    const ctx = own.length ? ` — по модели двери заявки ${door?.model ?? ''}` : best.features.matched.length ? ` — совпали: ${describeFeatures(qf, best.features.matched)}` : ' — модель двери в заявке не указана, взята самая дешёвая строка';
    notes.push(`комплектующее по прайсу: ${best.row.model}${where}${ctx}`);
  } else if (best.features) {
    // Строка прайса подошла по признакам: подпись «по прайсу: ДВ CPL (строка 17)» и пометка, что именно совпало.
    label = `по прайсу: ${best.row.model}${where}`;
    notes.push(`по прайсу: ${best.row.model}${where} — совпали: ${describeFeatures(qf, best.features.matched)}`);
    if (best.match === 'alias') notes.push(`по синониму: ${best.row.model}${inText && named(best.row) ? ` (слова синонима — в названии позиции, ID ${namedProductId})` : ''}`);
  } else {
    if (best.match === 'exact' && best.row.modelKey !== key) notes.push(`найдено по прайсу: ${best.row.model}${where}, по ${modelKeyOf(best.row.abbr ?? '') === key ? 'сокращению' : 'назначению'}`);
    if (best.match === 'alias') notes.push(`по синониму: ${best.row.model}${inText && named(best.row) ? ` (слова синонима — в названии позиции, ID ${namedProductId})` : ''}`);
    if (best.match === 'tokens' || best.match === 'similar') notes.push(`похожая модель в базе: ${best.row.model}${best.row.factory ? ` (${best.row.factory})` : ''}`);
    if (best.match === 'words') notes.push(`найдено по прайсу: ${best.row.model}${where}, совпадение ${Math.round(best.words * 100)} %`);
  }
  if (twoLists.length) notes.push(`найдено в ${twoLists.length === 2 ? 'двух' : twoLists.length} прайсах: ${twoLists.join(', ')} — взята более свежая`);
  // KP-NAME, п. 4: в письме назван цвет, которого нет в строке базы — менеджеру «цвет уточнить».
  const color = colorOf(text);
  if (color && !mentionsColor([best.row.model, best.row.coating, best.row.description, best.row.equipment, best.row.note].filter(Boolean).join(' | '), color)) {
    notes.push(`цвет уточнить: в письме «${color}», в строке ${best.row.origin === 'price_list' ? 'прайса' : 'базы'} ${best.row.model}${where} цвет не указан`);
  }
  if (stale) notes.push(`цена устарела: актуальна на ${best.row.validAt.toLocaleDateString('ru-RU')}, срок ${validityDays} дн.`);
  const confidence = best.match === 'words' ? Math.round(best.row.confidence * best.words) : best.row.confidence;
  // KB-PRICE-SHEETS: исход строки — своя цена / входит в блок / без цены / смета; примечания к КП из карточки.
  let outcome: NonNullable<PriceHit['outcome']> = 'priced';
  let price = bestApplied.price;
  let includedIn: string | null = null;
  if (best.row.category === 'hardware' && door && hardwareIncluded(best.row, door)) {
    outcome = 'included';
    // KB-DOOR-MATCH-2, п. 5: «входит в цену блока» — без цены, не 0 ₽.
    price = null;
    includedIn = door.productId ?? door.model;
    notes.push(`${best.row.model} входит в цену блока ${door.model}${door.card?.baseIncludes ? ` (в базу входит: ${door.card.baseIncludes})` : ''}`);
  } else if (price === null || price <= 0) {
    // KB-HW-NULL: цены в прайсе нет (NULL; 0 у записей до миграции 011 — так же) — «уточнить у менеджера», цена пустая, не 0 ₽.
    outcome = 'not_priced';
    price = null;
    notes.push(`уточнить у менеджера: цены на ${best.row.model}${best.row.tariffId ? ` (${best.row.tariffId})` : ''} в прайсе нет${best.row.card?.clarify ? ` — ${best.row.card.clarify}` : ''}`);
  } else if (best.row.estimate || best.row.status !== 'active') {
    outcome = 'estimate';
    if (best.row.estimate) notes.push(`сметная цена${best.row.card?.estimateFormula ? `: ${best.row.card.estimateFormula}` : ''} — для сметы, уточнить у менеджера`);
    if (best.row.status === 'inactive') notes.push(`позиция ${best.row.productId ?? best.row.model} неактивна в прайсе — только для сметы, уточнить у менеджера`);
    else if (best.row.status === 'estimate_only' && !best.row.estimate) notes.push(`позиция ${best.row.productId ?? best.row.model} в прайсе только для сметы — уточнить у менеджера`);
  }
  if (best.row.category === 'hardware' && best.row.appliesTo.length && !q.doorProductId) notes.push(`фурнитура для моделей ${best.row.appliesTo.join(', ')} — модель двери в заявке не определена`);
  if (otherModels) notes.push(`уточнить у менеджера: ${best.row.model} в прайсе для моделей ${best.row.appliesTo.join(', ')}, а дверь в заявке — ${q.doorProductId}`);
  if (best.row.card?.clarify && outcome === 'priced') notes.push(`уточнить: ${best.row.card.clarify}`);
  const quoteNotes = best.row.card?.quoteNotes ?? [];
  return { row: best.row, price, basis: bestApplied.basis, match: best.match, similarity: best.match === 'words' ? best.words : best.similarity, confidence, stale, validityDays, notes, label, features: best.features ? { matched: best.features.matched, query: qf } : null, outcome, quoteNotes, includedIn };
}

const BASIS_NAME: Record<UnitBasis, string> = { leaf: 'полотну', block: 'блоку', leaf_pair: 'паре полотен', opening: 'проёму' };

/** Подпись двери прайса для пометок: «INT-013, ДПГ CPL». */
export const doorTitleOf = (door: Pick<KbPrice, 'productId' | 'model'>): string => `${door.productId ? `${door.productId}, ` : ''}${door.model}`;

/**
 * KB-COMPONENT-DOOR: цена комплектующего (коробка, наличник, добор, порог) — только из строки прайса своей двери: колонка этой
 * двери («Коробка (ДПГ CPL)» с тем же ID товара; у одностраничного прайса — «комплектующее к <модель двери>» того же файла) и
 * статус компонента в её карточке. included → «входит в цену блока»; not_priced или колонки нет → «уточнить у менеджера», не 0.
 */
export async function componentOfDoor(prices: KbPricesRepo, accountId: number, door: KbPrice, kind: ComponentKind, now = new Date()): Promise<PriceHit> {
  const title = doorTitleOf(door);
  const st = door.componentStatus?.[kind] ?? null;
  if (st === 'included') return { ...doorOutcome(door, 'included', [`${kind} входит в цену блока ${title}${door.card?.baseIncludes ? ` (в базу входит: ${door.card.baseIncludes})` : ''}`], now), label: `по двери ${title}` };
  if (st === 'not_priced') return { ...doorOutcome(door, 'not_priced', [`уточнить у менеджера: ${kind} к двери ${title} в прайсе без цены`], now), label: `по двери ${title}` };
  const own = door.productId
    ? (await prices.rowsByProductId(accountId, door.productId)).filter((r) => r.category === 'component' && r.componentKind === kind && r.origin === 'price_list')
    : (await prices.listByOrigin(accountId, 'price_list')).filter((r) => r.category === 'component' && r.componentKind === kind && r.sourceId === door.sourceId && r.description === `комплектующее к ${door.model}`);
  const row = own.find(hasPrice);
  if (!row) return { ...doorOutcome(door, 'not_priced', [`уточнить у менеджера: у двери ${title} в прайсе нет цены на ${kind}`], now), label: `по двери ${title}` };
  const validityDays = validityDaysOf(row);
  const stale = now.getTime() - row.validAt.getTime() > validityDays * 86_400_000;
  const where = row.sourceRow ? ` (строка ${row.sourceRow})` : '';
  const notes = [`комплектующее по двери ${title}: ${row.model}${where}`];
  if (stale) notes.push(`цена устарела: актуальна на ${row.validAt.toLocaleDateString('ru-RU')}, срок ${validityDays} дн.`);
  return { row, price: row.price as number, basis: 'base', match: 'exact', similarity: 1, confidence: row.confidence, stale, validityDays, notes, label: `по двери ${title}`, features: null, outcome: 'priced', quoteNotes: [] };
}

/** Исход «входит в блок» / «без цены» по карточке двери: строка двери, цена 0, подпись прайса двери. */
function doorOutcome(door: KbPrice, outcome: 'included' | 'not_priced', notes: string[], now: Date): PriceHit {
  const validityDays = validityDaysOf(door);
  const where = door.sourceRow ? ` (строка ${door.sourceRow})` : '';
  return { row: door, price: null, basis: 'base', match: 'exact', similarity: 1, confidence: door.confidence, stale: now.getTime() - door.validAt.getTime() > validityDays * 86_400_000, validityDays, notes, label: `по прайсу: ${door.model}${where}`, features: null, outcome, quoteNotes: [], includedIn: outcome === 'included' ? door.productId ?? door.model : null };
}

/** Фурнитура уже в базе двери: тариф или название упомянуты в «Входит в базу» / комментарии / комплектации двери (ALU-005 — фрамуга, MET-012 — вентиляция). */
export function hardwareIncluded(hw: Pick<KbPrice, 'tariffId' | 'model' | 'modelKey'>, door: Pick<KbPrice, 'card' | 'equipment'>): boolean {
  const hay = normalizeKey([door.card?.baseIncludes, door.card?.comment, door.equipment, ...(door.card?.includes ? [door.card.includes] : [])].filter(Boolean).join(' | '));
  if (!hay) return false;
  if (hw.tariffId && hay.includes(normalizeKey(hw.tariffId))) return true;
  const head = tokensOf(hw.modelKey).filter((t) => t.length >= 4 && !FINISH_WORDS.has(t));
  // Все значимые слова названия («фрамуга», «вентиляционная решётка») есть в тексте базы двери — с усечением окончаний.
  return head.length > 0 && head.every((t) => hay.includes(t.slice(0, Math.max(4, t.length - 2))));
}

/**
 * Медиана прайса для фильтра реалистичности веб-цены (KB-COMPONENTS, п. 2): двери — по совместимой группе признаков среди
 * дверей; комплектующие — по строкам того же вида (добор, коробка…); фурнитура — по строкам, у которых общее первое слово
 * («ручка», «петля»). Группы нет — null, фильтр не применяется.
 */
export function categoryMedian(rows: Pick<KbPrice, 'category' | 'componentKind' | 'featureKey' | 'price' | 'modelKey'>[], q: { category: PositionCategory; features: DoorFeatures; componentKind: ComponentKind | null; tokens: string[] }): number | null {
  // KB-HW-NULL: строки без цены в медиану не входят — иначе тариф без цены тянул медиану к нулю и веб-цены отбрасывались.
  const priced = rows.filter((r) => r.category === q.category).filter(hasPrice);
  if (q.category === 'door') return priceListMedian(priced, featureKeyOf(q.features));
  let group: number[] = [];
  if (q.category === 'component') group = priced.filter((r) => q.componentKind && r.componentKind === q.componentKind).map((r) => r.price);
  if (q.category === 'hardware') {
    const head = q.tokens[0];
    group = head ? priced.filter((r) => r.modelKey.split(' ')[0] === head).map((r) => r.price) : [];
    // KB-PRICE-SHEETS-FIX, п. 5: своей группы по первому слову нет («автопорог») — медиана всей фурнитуры прайса с ценой,
    // чтобы веб-цена 27 295 ₽ за автопорог не прошла как реальная.
    if (!group.length) group = priced.map((r) => r.price);
  }
  if (!group.length) return null;
  const sorted = [...group].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Текст строки базы содержит цвет из письма (без регистра, «светло-серый» = «светло серый»). */
const mentionsColor = (text: string, color: string): boolean => {
  const n = (x: string) => x.toLowerCase().replace(/ё/g, 'е').replace(/[-\s]+/g, '');
  return n(text).includes(n(color));
};

/** Приоритет происхождения при равном совпадении модели и размера (KB-PRICELIST, д). */
export const ORIGIN_RANK: Record<PriceOrigin, number> = { price_list: 0, purchase: 1, manager: 2, web: 3 };
/** Минимальная доля общих слов для подбора по словам. */
export const WORDS_MIN = 0.5;

/** Доля общих слов (Жаккар) между словами позиции и словами записи прайса. */
export function wordsScore(query: Set<string>, rowTokens: string[]): number {
  if (!query.size || !rowTokens.length) return 0;
  const r = new Set(rowTokens);
  let common = 0;
  for (const w of query) if (r.has(w)) common += 1;
  const union = query.size + r.size - common;
  return union ? common / union : 0;
}

/** Известное название из базы (этап 4): синоним → каноническое; иначе точная модель из kb_prices (с фабрикой). */
export interface KnownName {
  name: string;
  via: 'alias' | 'price';
  factory: string | null;
}

/**
 * Нормализация названий позиций без модели: для каждого названия — каноническое из синонимов или модель из цен
 * (точное совпадение ключа). Что не нашлось — остаётся модели (gpt) на этапе разбора таблицы.
 */
export async function knownModelNames(prices: KbPricesRepo, aliases: KbAliasesRepo, accountId: number, names: string[]): Promise<Map<number, KnownName>> {
  const out = new Map<number, KnownName>();
  const cache = new Map<string, KnownName | null>();
  for (const [i, name] of names.entries()) {
    const key = modelKeyOf(name);
    if (!key) continue;
    let hit = cache.get(key);
    if (hit === undefined) {
      const alias = await aliases.resolve(accountId, key);
      if (alias) hit = { name: alias.canonical, via: 'alias', factory: null };
      else {
        const rows = await prices.candidates(accountId, [key]);
        const exact = rows.find((r) => r.row.modelKey === key || r.row.altKeys.includes(key))?.row;
        hit = exact ? { name: exact.model, via: 'price', factory: exact.factory } : null;
      }
      cache.set(key, hit);
    }
    if (hit) out.set(i, hit);
  }
  return out;
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
    price: r.price === null || r.price === undefined ? null : Number(r.price),
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
    abbr: (r.abbr ?? null) as string | null,
    description: (r.description ?? null) as string | null,
    altKeys: Array.isArray(r.alt_keys) ? (r.alt_keys as string[]) : [],
    searchTokens: Array.isArray(r.search_tokens) ? (r.search_tokens as string[]) : [],
    sourceRow: r.source_row === null || r.source_row === undefined ? null : Number(r.source_row),
    features: (r.features ?? null) as DoorFeatures | null,
    featureKey: (r.feature_key ?? null) as string | null,
    coating: (r.coating ?? null) as string | null,
    equipment: (r.equipment ?? null) as string | null,
    priceKey: (r.price_key ?? null) as string | null,
    priceTitle: r.price_key ? priceListTitleOf(String(r.price_key)) : null,
    category: ((r.category as string | undefined) ?? 'door') as PositionCategory,
    componentKind: (r.component_kind ?? null) as ComponentKind | null,
    productId: (r.product_id ?? null) as string | null,
    tariffId: (r.tariff_id ?? null) as string | null,
    status: ((r.status as string | undefined) ?? 'active') as ProductStatus,
    estimate: Boolean(r.estimate),
    family: (r.family ?? null) as Family | null,
    appliesTo: Array.isArray(r.applies_to) ? (r.applies_to as string[]) : [],
    componentStatus: (r.component_status ?? null) as KbPrice['componentStatus'],
    card: (r.card ?? null) as ProductCard | null,
  };
}

function mapAlias(r: Record<string, unknown>): KbAlias {
  return { id: Number(r.id), accountId: Number(r.account_id), alias: String(r.alias ?? ''), aliasKey: String(r.alias_key ?? ''), canonical: String(r.canonical ?? ''), canonicalKey: String(r.canonical_key ?? ''), sourceId: r.source_id === null || r.source_id === undefined ? null : Number(r.source_id), createdAt: r.created_at as Date, productId: (r.product_id ?? null) as string | null };
}
