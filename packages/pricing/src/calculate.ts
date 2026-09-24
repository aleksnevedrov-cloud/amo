import type { Component, PricingRules } from './rules.ts';

export interface DoorInput {
  /** Карточка из каталога. */
  productId: string;
  name: string;
  category: string | null;
  price: number | null;
  widthMm?: number;
  heightMm?: number;
  qty: number;
}

export interface CalcInput {
  doors: DoorInput[];
  /** Добавлять комплект (коробка, наличники). */
  kit: boolean;
  /** Компоненты по явному запросу: доборы по толщине стены и т.п. */
  extras: { code: string; qty: number }[];
  /** Фурнитура и прочие товары из каталога. */
  products: { productId: string; name: string; price: number | null; qty: number }[];
  services: { code: string; km?: number; floor?: number }[];
}

export interface CalcLine {
  name: string;
  article: string | null;
  qty: number;
  unit: 'шт.';
  /** null — цену уточняет менеджер. */
  price: number | null;
  total: number | null;
  basis: string;
}

export interface CalcResult {
  lines: CalcLine[];
  /** Сумма позиций с известной ценой. */
  total: number;
  /** Все цены известны — итог полный. */
  complete: boolean;
  missing: string[];
  doorsCount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Подходящая цена компонента по серии двери. */
function componentPrice(c: Component, door: DoorInput): { price: number | null; series: string | null } {
  const hay = `${door.name} ${door.category ?? ''}`.toLowerCase();
  // Самое длинное совпадение — самое точное («Стэфани-22» важнее «Стэфани»).
  const match = [...c.prices]
    .sort((a, b) => b.series.length - a.series.length)
    .find((p) => hay.includes(p.series.toLowerCase()));
  if (match) return { price: match.price, series: match.series };
  return { price: c.defaultPrice, series: null };
}

/**
 * Черновик детализации сделки. Все суммы считаются здесь — агент их только пересказывает,
 * поэтому пост-фильтр видит итог в данных инструмента.
 */
export function calculate(rules: PricingRules, input: CalcInput): CalcResult {
  const lines: CalcLine[] = [];
  const missing: string[] = [];
  const add = (l: Omit<CalcLine, 'unit' | 'total'>) => {
    const total = l.price === null ? null : round2(l.price * l.qty);
    lines.push({ ...l, unit: 'шт.', total });
    if (l.price === null) missing.push(l.name);
  };
  const { standardWidths, standardHeights, nonStandardMarkupPct } = rules.sizes;

  // Полотна.
  for (const d of input.doors) {
    const size = d.widthMm && d.heightMm ? ` ${d.widthMm / 10}*${d.heightMm / 10}` : '';
    const nonStandard =
      (d.widthMm !== undefined && !standardWidths.includes(d.widthMm)) ||
      (d.heightMm !== undefined && !standardHeights.includes(d.heightMm));
    if (d.price === null) {
      add({ name: `${d.name}${size}`, article: d.productId, qty: d.qty, price: null, basis: 'нет цены в каталоге' });
    } else if (nonStandard && nonStandardMarkupPct === null) {
      add({ name: `${d.name}${size}`, article: d.productId, qty: d.qty, price: null, basis: 'нестандартный размер — цену считает менеджер' });
    } else if (nonStandard) {
      const price = round2(d.price * (1 + (nonStandardMarkupPct ?? 0) / 100));
      add({ name: `${d.name}${size}`, article: d.productId, qty: d.qty, price, basis: `каталог ${d.price} ₽ + ${nonStandardMarkupPct}% за нестандартный размер` });
    } else {
      add({ name: `${d.name}${size}`, article: d.productId, qty: d.qty, price: d.price, basis: 'цена из каталога' });
    }
  }
  const doorsCount = input.doors.reduce((n, d) => n + d.qty, 0);

  // Комплект: по каждому компоненту считаем количество и цену по сериям дверей.
  const componentLines = (c: Component, perDoor: (d: DoorInput) => number) => {
    const groups = new Map<string, { price: number | null; series: string | null; qty: number }>();
    for (const d of input.doors) {
      const { price, series } = componentPrice(c, d);
      const key = `${series ?? ''}|${price ?? 'null'}`;
      const g = groups.get(key) ?? { price, series, qty: 0 };
      g.qty += perDoor(d);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const qty = c.roundUp ? Math.ceil(g.qty - 1e-9) : round2(g.qty);
      if (qty <= 0) continue;
      add({
        name: c.name,
        article: null,
        qty,
        price: g.price,
        basis:
          g.price === null
            ? 'нет цены для серии — уточнит менеджер'
            : `правило: ${c.name}${g.series ? ` для серии «${g.series}»` : ''}`,
      });
    }
  };
  if (input.kit && input.doors.length) {
    for (const c of rules.components.filter((x) => x.inKit && x.qtyPerDoor > 0)) {
      componentLines(c, (d) => d.qty * c.qtyPerDoor);
    }
  }
  // Явные позиции (доборы): общее количество распределяем по сериям пропорционально дверям.
  for (const e of input.extras) {
    const c = rules.components.find((x) => x.code === e.code);
    if (!c) {
      missing.push(`неизвестная позиция «${e.code}»`);
      continue;
    }
    if (!input.doors.length) {
      add({ name: c.name, article: null, qty: e.qty, price: c.defaultPrice, basis: `правило: ${c.name}` });
      continue;
    }
    componentLines({ ...c, roundUp: true }, (d) => (e.qty * d.qty) / doorsCount);
  }

  // Товары из каталога (фурнитура).
  for (const p of input.products) {
    add({ name: p.name, article: p.productId, qty: p.qty, price: p.price, basis: p.price === null ? 'нет цены в каталоге' : 'цена из каталога' });
  }

  // Услуги.
  for (const s of input.services) {
    const svc = rules.services.find((x) => x.code === s.code);
    if (!svc) {
      missing.push(`неизвестная услуга «${s.code}»`);
      continue;
    }
    switch (svc.unit) {
      case 'fixed':
        add({ name: svc.name, article: null, qty: 1, price: svc.price, basis: 'услуга, за заказ' });
        break;
      case 'per_door':
        add({ name: svc.name, article: null, qty: doorsCount || 1, price: svc.price, basis: 'услуга, за дверь' });
        break;
      case 'per_km': {
        if (s.km === undefined) {
          add({ name: svc.name, article: null, qty: 1, price: null, basis: 'нужно расстояние, км' });
        } else {
          const price = round2(svc.basePrice + svc.price * s.km);
          add({ name: `${svc.name} (${s.km} км)`, article: null, qty: 1, price, basis: `${svc.basePrice} ₽ + ${svc.price} ₽ × ${s.km} км` });
        }
        break;
      }
      case 'per_door_per_floor': {
        if (s.floor === undefined) {
          add({ name: svc.name, article: null, qty: doorsCount || 1, price: null, basis: 'нужен этаж' });
        } else {
          const floors = Math.max(s.floor, 0);
          add({ name: `${svc.name} (${floors} эт.)`, article: null, qty: doorsCount || 1, price: round2(svc.price * floors), basis: `${svc.price} ₽ за дверь за этаж` });
        }
        break;
      }
    }
  }

  const total = round2(lines.reduce((sum, l) => sum + (l.total ?? 0), 0));
  return { lines, total, complete: missing.length === 0, missing, doorsCount };
}
