import { missingFields, PROFILE_LABEL, profileLine, withMarkup, type GostProfile } from '@opt/kb';
import { isPriceFile, lineCategory, tidyName, type KpAnswer, type KpLine, type KpPayload } from './draft.ts';

/**
 * Опросник менеджеру (KP-AGENT-V2, п. 5). Вопросы не хранятся — они выводятся из состояния черновика при каждом показе;
 * хранятся только ответы (payload.answers) по ключу «тип вопроса + позиция»: одинаковые строки заявки дают один ключ, один ответ
 * применяется ко всем. Цена в ответе хранится уже вычисленной, поэтому ответы переносятся на новый черновик при «Собрать заново».
 * КП не собирается, пока есть открытые вопросы с флагом «блокирует».
 */
export type QuestionType = 'incomplete' | 'model_choice' | 'analog' | 'web_price' | 'enter_price' | 'nonstandard' | 'component_door' | 'photo' | 'delivery' | 'price_validity';

export interface KpQuestionOption {
  id: string;
  label: string;
  detail?: string | null;
  price?: number | null;
  /** KB-MARKUP: цена фабрики варианта (до наценки источника) — для «фабрика · наценка · цена» и «Пересчитать». */
  factoryPrice?: number | null;
}

export type NonstandardChoice = 'computed' | 'p30' | 'p100';

/** KB-MARKUP: вариант «нестандарт» — сначала надбавка к цене фабрики (+30 % / +100 %), затем наценка источника. */
export function nonstandardOption(choice: 'p30' | 'p100', factoryBase: number, pct: number): { factoryPrice: number; price: number } {
  const factoryPrice = choice === 'p30' ? Math.round(factoryBase * 1.3 * 100) / 100 : factoryBase * 2;
  return { factoryPrice, price: withMarkup(factoryPrice, pct) };
}

export interface KpQuestion {
  key: string;
  type: QuestionType;
  blocking: boolean;
  title: string;
  text: string;
  requestIndexes: number[];
  options: KpQuestionOption[];
  /** Поля ввода (неполная позиция, доставка, срок действия цены). */
  fields?: { name: string; label: string; value: string | null }[];
  /** Можно ввести свою цену. */
  customPrice?: boolean;
  /** Цены интернета: min / медиана / max, источники, почему выбран сайт. */
  web?: KpLine['web'];
  /** Текст уточнения для клиента — агент готовит, менеджер отправляет сам (п. 5.3). */
  askClient: string | null;
  answer: KpAnswer | null;
}

const rowKeyOf = (payload: Partial<KpPayload>, l: KpLine): string =>
  `${tidyName(payload.request_items?.[l.request_index]?.name || l.name).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()}|${l.size || ''}`;

/** Ключ вопроса: тип и позиция (название заявки + размер); одинаковые строки — один ключ. */
export const questionKey = (type: QuestionType, payload: Partial<KpPayload>, l: KpLine): string => `${type}:${rowKeyOf(payload, l)}`;

const ROW_TITLE: Partial<Record<QuestionType, string>> = { incomplete: 'Неполная позиция', model_choice: 'Выбор модели', analog: 'Аналог', web_price: 'Цена из интернета', enter_price: 'Введите цену', nonstandard: 'Нестандартный размер' };
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const labelOf = (l: KpLine, count: number) => `«${l.name}»${l.size ? `, ${l.size}` : ''}${count > 1 ? ` (строк ${count})` : ''}`;

/** Цена строки поставлена с источником, который ставит её в КП: прайс, интернет с выбором менеджера, ввод менеджера. */
export const hasSourcedPrice = (l: KpLine): boolean => l.price !== null && (isPriceFile(l.priceSource) || l.priceSource === 'web_confirmed' || l.priceSource === 'manager');

export interface QuestionOptions {
  /** Срок действия цены из настроек; пусто — вопрос в опросник. */
  priceValidity?: string | null;
}

/** Вопросы черновика: по позициям (группами одинаковых строк), фото, доставка, срок действия цены. */
export function buildQuestions(payload: Partial<KpPayload>, opts: QuestionOptions = {}): KpQuestion[] {
  const goods = (payload.items ?? []).filter((l) => !(l.kind === 'service' || lineCategory(l) === 'service'));
  const items = goods.filter((l) => !l.excluded);
  const answers = payload.answers ?? {};
  const out: KpQuestion[] = [];
  const groups = new Map<string, KpLine[]>();
  for (const l of items) groups.set(rowKeyOf(payload, l), [...(groups.get(rowKeyOf(payload, l)) ?? []), l]);
  const push = (q: Omit<KpQuestion, 'answer'>) => out.push({ ...q, answer: answers[q.key] ?? null });
  const answered = (type: QuestionType, l: KpLine) => Boolean(answers[questionKey(type, payload, l)]);

  // Комплектующие → «к какой двери» (группами KB-COMPONENT-DOOR-GROUP; ответ — POST /kp/draft/:id/component-door).
  const componentGroups = new Map<string, KpLine[]>();
  for (const l of items) if (l.priceOutcome === 'question' && l.question) componentGroups.set(l.question.group ?? `row:${l.request_index}`, [...(componentGroups.get(l.question.group ?? `row:${l.request_index}`) ?? []), l]);
  for (const [group, lines] of componentGroups) {
    const q = (lines[0] as KpLine).question;
    if (!q) continue;
    const qty = lines.reduce((s, l) => s + l.qty, 0);
    push({ key: `component_door:${group}`, type: 'component_door', blocking: true, title: 'Комплектующие — к какой двери', text: `К какой двери считать «${q.groupTitle ?? (lines[0] as KpLine).name}» (строк ${lines.length}, ${qty} шт)?`, requestIndexes: lines.map((l) => l.request_index), options: q.options.map((o) => ({ id: String(o.requestIndex), label: [o.productId, o.model, o.size, `${o.qty} шт`].filter(Boolean).join(' · ') })), askClient: null });
  }

  for (const lines of groups.values()) {
    const l = lines[0] as KpLine;
    if (l.priceOutcome === 'question') continue;
    const idx = lines.map((x) => x.request_index);
    const what = labelOf(l, lines.length);
    const door = lineCategory(l) === 'door';
    const priced = hasSourcedPrice(l);
    const profile: GostProfile | null = l.gostProfile ?? null;
    // 1. Неполная позиция: обязательные поля ГОСТ-профиля, количество.
    const fixed = l.profileFix ?? {};
    const missing = [...(door && profile ? missingFields(profile) : []), ...(l.qtyUnknown ? ['qty'] : [])].filter((f) => !(f in fixed));
    if (missing.length) {
      const key = questionKey('incomplete', payload, l);
      push({
        key,
        type: 'incomplete',
        // Позиция без цены прайса или без количества / размера — решать до КП; дверь, отнесённая к строке прайса, дополнена ею.
        blocking: !priced || missing.includes('qty') || missing.includes('size'),
        title: 'Неполная позиция',
        text: `${what}: не указано — ${missing.map((f) => (f === 'qty' ? 'количество' : PROFILE_LABEL[f] ?? f)).join(', ')}.${profile ? ` Профиль: ${profileLine(profile)}.` : ''}`,
        requestIndexes: idx,
        options: [],
        fields: missing.map((f) => ({ name: f, label: f === 'qty' ? 'Количество, шт' : f === 'size' ? 'Размер Н×Ш, мм' : PROFILE_LABEL[f] ?? f, value: null })),
        askClient: `Добрый день! Уточните, пожалуйста, по позиции «${l.name}»${l.size ? ` (${l.size})` : ''}: ${missing.map((f) => (f === 'qty' ? 'количество' : PROFILE_LABEL[f] ?? f)).join(', ')}.`,
      });
    }
    // 2. Двупольная неравнопольная — решение человека.
    // KB-MARKUP: проценты — к цене фабрики, наценка источника — после (без наценки варианты те же, что раньше).
    const pct = l.markup && l.markup.price === l.price ? l.markup.pct : 0;
    const variant = (id: 'p30' | 'p100', base: number, label: (price: number) => string) => {
      const o = nonstandardOption(id, base, pct);
      return { id, label: label(o.price), price: o.price, factoryPrice: o.factoryPrice };
    };
    if (door && profile?.unequal) {
      const base = l.price;
      const factory = pct ? (l.markup as NonNullable<KpLine['markup']>).factoryPrice : base;
      push({ key: questionKey('nonstandard', payload, l), type: 'nonstandard', blocking: true, title: 'Двустворчатая неравнопольная', text: `${what}: двупольная неравнопольная — как считать цену?${base ? ` Сейчас ${rub(base)}.` : ''}`, requestIndexes: idx, options: base && factory ? [variant('p30', factory, () => '+30 % к цене'), variant('p100', factory, () => '+100 % к цене')] : [], customPrice: true, askClient: null });
    } else if (l.nonstandard && l.price !== null && isPriceFile(l.priceSource)) {
      // 3. Нестандарт (правила прайса / по площади) — цена посчитана, решает человек.
      const base = l.nonstandard.basePrice;
      push({
        key: questionKey('nonstandard', payload, l),
        type: 'nonstandard',
        blocking: true,
        title: 'Нестандартный размер',
        text: `${what}: ${l.nonstandard.note}. Посчитано ${rub(l.price)}.`,
        requestIndexes: idx,
        options: [{ id: 'computed', label: `Как посчитано: ${rub(l.price)}`, price: l.price }, ...(base ? [variant('p30', base, (p) => `+30 % к базе: ${rub(p)}`), variant('p100', base, (p) => `+100 % к базе: ${rub(p)}`)] : [])],
        customPrice: true,
        askClient: null,
      });
    }
    // 4. Выбор модели: одинаково подходят несколько строк прайса.
    if (l.modelOptions?.length && !l.chosenProductId) {
      push({ key: questionKey('model_choice', payload, l), type: 'model_choice', blocking: true, title: 'Выбор модели', text: `${what} подходит к нескольким моделям прайса — какая?`, requestIndexes: idx, options: [...l.modelOptions.map((o) => ({ id: o.productId, label: `${o.productId} · ${o.model}` })), { id: 'no_price', label: 'Оставить без цены («уточнить у менеджера» в КП)' }], askClient: `Добрый день! Уточните, пожалуйста, модель по позиции «${l.name}»: ${l.modelOptions.map((o) => o.model).join(' / ')}?` });
      continue;
    }
    // 5. Аналог: бренд клиента вне прайса.
    if (door && profile?.brand && !priced && !l.chosenProductId && !l.askWeb) {
      push({
        key: questionKey('analog', payload, l),
        type: 'analog',
        blocking: true,
        title: 'Аналог',
        text: `${what}: бренд «${profile.brand}» в прайсе нет. Аналог по ГОСТ допустим?`,
        requestIndexes: idx,
        options: [...(l.analogOptions ?? []).map((o) => ({ id: `analog:${o.productId}`, label: `Аналог по ГОСТ: ${o.productId} · ${o.model}`, price: o.price })), { id: 'web', label: `Искать «${profile.brand}» в интернете` }, { id: 'exclude', label: 'Исключить позицию' }],
        askClient: `Добрый день! Позиции «${l.name}» (${profile.brand}) нет в нашем прайсе. Подойдёт ли аналог по ГОСТ ${profile.gost ?? ''}?`.replace(/\s+\?/, '?'),
      });
      continue;
    }
    // 6. Цена из интернета — всегда вопрос; цену выбирает менеджер.
    if (l.web && (!priced || answered('web_price', l))) {
      const w = l.web;
      const warn = [!w.enough ? `источников ${w.count} — меньше трёх и нет фабрики` : '', w.spreadPct > 30 ? `разброс ${w.spreadPct} %` : ''].filter(Boolean).join('; ');
      push({ key: questionKey('web_price', payload, l), type: 'web_price', blocking: true, title: 'Цена из интернета', text: `${what}: цены интернета ${rub(w.min)} – ${rub(w.max)}, медиана ${rub(w.median)} (${w.count} источн.)${warn ? ` — ${warn}` : ''}. Итоговая цена?`, requestIndexes: idx, options: [{ id: 'median', label: `Медиана ${rub(w.median)}`, price: w.median }, { id: 'min', label: `Минимум ${rub(w.min)}`, price: w.min }, { id: 'max', label: `Максимум ${rub(w.max)}`, price: w.max }, { id: 'no_price', label: 'Оставить без цены («уточнить у менеджера» в КП)' }], customPrice: true, web: w, askClient: null });
      continue;
    }
    // 7. Цены нет ни в прайсе, ни в интернете — ввести.
    if ((!priced && l.priceOutcome !== 'included') || answered('enter_price', l)) {
      push({ key: questionKey('enter_price', payload, l), type: 'enter_price', blocking: true, title: 'Введите цену', text: `${what}: цены нет ни в прайсе, ни в интернете.`, requestIndexes: idx, options: [{ id: 'no_price', label: 'Оставить без цены («уточнить у менеджера» в КП)' }], customPrice: true, askClient: null });
    }
  }

  // Отвеченные вопросы, которых по состоянию строки уже нет (модель выбрана, позиция исключена, цена стоит), — показываются
  // с ответом: менеджер видит, что решено, и может ответить иначе.
  const shown = new Set(out.map((q) => q.key));
  for (const [key, a] of Object.entries(answers)) {
    const type = key.split(':')[0] as QuestionType;
    if (shown.has(key) || !(type in ROW_TITLE)) continue;
    const lines = goods.filter((l) => questionKey(type, payload, l) === key);
    if (!lines.length) continue;
    out.push({ key, type, blocking: true, title: ROW_TITLE[type] as string, text: `${labelOf(lines[0] as KpLine, lines.length)}: ответ дан.`, requestIndexes: lines.map((l) => l.request_index), options: [], askClient: null, answer: a });
  }

  // Фото-образец — к какой позиции.
  for (const ph of payload.photos ?? []) {
    push({ key: `photo:${ph.name}`, type: 'photo', blocking: false, title: 'Фото-образец', text: `Фото «${ph.name}» без текста — образец к какой позиции?`, requestIndexes: [], options: [...items.filter((l) => lineCategory(l) === 'door').slice(0, 30).map((l) => ({ id: `pos:${l.request_index}`, label: `${l.request_index + 1}. ${l.name}${l.size ? `, ${l.size}` : ''}` })), { id: 'ignore', label: 'Игнорировать' }], askClient: `Добрый день! Фото «${ph.name}» — образец к какой позиции заявки?` });
  }

  // Доставка — всегда.
  const address = payload.delivery?.address ?? deliveryAddressOf(payload);
  push({ key: 'delivery', type: 'delivery', blocking: true, title: 'Доставка', text: `Доставка${address ? ` по адресу: ${address}` : ''} — сумма или самовывоз?`, requestIndexes: [], options: [{ id: 'delivery', label: 'Доставка (адрес и сумма)' }, { id: 'pickup', label: 'Самовывоз' }], fields: [{ name: 'address', label: 'Адрес', value: address }, { name: 'sum', label: 'Сумма доставки с НДС, ₽', value: null }], askClient: address ? null : 'Добрый день! Уточните, пожалуйста, адрес доставки.' });

  // Срок действия цены — если не задан в настройках.
  if (!opts.priceValidity?.trim()) {
    push({ key: 'price_validity', type: 'price_validity', blocking: true, title: 'Срок действия цены', text: 'Срок действия цены в настройках не задан — сколько действует цена этого КП?', requestIndexes: [], options: [], fields: [{ name: 'text', label: 'Срок действия цены', value: payload.priceValidity ?? null }], askClient: null });
  }
  return out;
}

/** Адрес доставки из требований заявки («Место поставки: …», «адрес доставки …»). */
export function deliveryAddressOf(payload: Partial<KpPayload>): string | null {
  for (const r of payload.requirements ?? []) {
    const m = /(?:место поставки|адрес[а-яё]* (?:поставки|доставки)|доставка (?:по адресу|до))\s*[:—-]?\s*(.+)/i.exec(r);
    if (m?.[1]) return m[1].trim().slice(0, 200);
  }
  return null;
}

export const openQuestions = (qs: KpQuestion[]): KpQuestion[] => qs.filter((q) => !q.answer);
export const blockingOpen = (qs: KpQuestion[]): KpQuestion[] => qs.filter((q) => q.blocking && !q.answer);

/** Счётчики для узкой колонки и шапки окна (п. 6а): позиций, открытых вопросов (из них блокирует), без цены. */
export function draftCounters(payload: Partial<KpPayload>, qs: KpQuestion[]): { positions: number; open: number; blocking: number; unpriced: number } {
  const goods = (payload.items ?? []).filter((l) => !(l.kind === 'service' || lineCategory(l) === 'service') && !l.excluded);
  return { positions: goods.length, open: openQuestions(qs).length, blocking: blockingOpen(qs).length, unpriced: goods.filter((l) => !hasSourcedPrice(l) && l.priceOutcome !== 'included').length };
}

/** Цена, которую ставит ответ: вариант с ценой или своя цена. */
const answerPrice = (q: KpQuestion | null, a: KpAnswer): number | null => {
  if (a.price !== null && a.price !== undefined && a.price > 0) return a.price;
  const o = q?.options.find((x) => x.id === a.option);
  return o?.price ?? null;
};

export interface AppliedAnswer {
  payload: Partial<KpPayload>;
  /** Позиции, которые нужно подобрать заново (модель, аналог, интернет, уточнённый профиль). */
  research: number[];
  /** Цены, подтверждённые менеджером, — в «кандидаты в прайс». */
  candidates: { requestIndex: number; model: string; size: string; price: number; source: 'web_confirmed' | 'manager'; url: string | null }[];
}

/**
 * Ответ на вопрос → черновик: цена (с вычисленным значением в ответе), модель / аналог / интернет / исключение, поля профиля,
 * доставка, срок действия цены, фото. q — вопрос из buildQuestions (null при переносе ответа на новый черновик: тип — из ключа).
 */
export function applyAnswer(payload: Partial<KpPayload>, key: string, answer: KpAnswer, q: KpQuestion | null = null): AppliedAnswer {
  const type = (q?.type ?? key.split(':')[0]) as QuestionType;
  const price = answerPrice(q, answer);
  const stored: KpAnswer = { ...answer, ...(price !== null ? { price } : {}) };
  const research: number[] = [];
  const candidates: AppliedAnswer['candidates'] = [];
  const next: Partial<KpPayload> = { ...payload, answers: { ...(payload.answers ?? {}), [key]: stored } };
  const rowKey = key.slice(key.indexOf(':') + 1);
  const mine = (l: KpLine) => `${type}:${rowKeyOf(payload, l)}` === key || rowKeyOf(payload, l) === rowKey;
  const items = [...(payload.items ?? [])];
  const patch = (fn: (l: KpLine) => KpLine) => {
    for (const [i, l] of items.entries()) if (mine(l) && lineCategory(l) !== 'service') items[i] = fn(l);
  };
  switch (type) {
    case 'web_price':
    case 'enter_price':
    case 'nonstandard': {
      if (answer.option === 'no_price') {
        patch((l) => ({ ...l, price: null, priceOutcome: 'not_priced', priceLabel: 'уточнить у менеджера' }));
        break;
      }
      if (price === null) break;
      const src: KpLine['priceSource'] = type === 'web_price' && answer.option !== null && answer.option !== 'custom' ? 'web_confirmed' : type === 'nonstandard' && answer.option !== 'custom' ? 'price_file' : 'manager';
      patch((l) => {
        const url = l.web?.sources[0]?.url ?? null;
        if (src !== 'price_file') candidates.push({ requestIndex: l.request_index, model: l.name, size: l.size, price, source: src === 'web_confirmed' ? 'web_confirmed' : 'manager', url: src === 'web_confirmed' ? url : null });
        const label = src === 'web_confirmed' ? `из интернета (${l.web?.count ?? 0} источн.), выбрал менеджер` : src === 'manager' ? 'введена менеджером' : nonstandardLabel(answer.option as NonstandardChoice);
        // KB-MARKUP: вариант «нестандарт» из прайса — с наценкой источника (цена фабрики варианта — для «Пересчитать»); своя цена — без.
        const option = q?.options.find((o) => o.id === answer.option);
        const markup = src === 'price_file' && l.markup ? (answer.option === 'computed' ? l.markup : option?.factoryPrice ? { ...l.markup, factoryPrice: option.factoryPrice, price } : null) : null;
        const choice = type === 'nonstandard' && src === 'price_file' ? (answer.option as NonstandardChoice) : null;
        return { ...l, price, priceSource: src, priceLabel: label, priceOutcome: 'priced', priceStale: false, markup, nonstandardChoice: choice };
      });
      break;
    }
    case 'model_choice':
      if (answer.option === 'no_price') patch((l) => ({ ...l, price: null, priceOutcome: 'not_priced', priceLabel: 'уточнить у менеджера' }));
      else if (answer.option) {
        patch((l) => ({ ...l, chosenProductId: answer.option, modelOptions: null }));
        research.push(...items.filter(mine).map((l) => l.request_index));
      }
      break;
    case 'analog':
      if (answer.option === 'exclude') patch((l) => ({ ...l, excluded: true, price: null }));
      else if (answer.option === 'web') {
        patch((l) => ({ ...l, askWeb: true }));
        research.push(...items.filter(mine).map((l) => l.request_index));
      } else if (answer.option?.startsWith('analog:')) {
        const id = answer.option.slice('analog:'.length);
        patch((l) => ({ ...l, chosenProductId: id }));
        research.push(...items.filter(mine).map((l) => l.request_index));
      }
      break;
    case 'incomplete': {
      const f = answer.fields ?? {};
      patch((l) => {
        const fix = { ...(l.profileFix ?? {}), ...f };
        const out: KpLine = { ...l, profileFix: fix };
        const qty = Number((f.qty ?? '').replace(',', '.'));
        if (qty > 0) {
          out.qty = Math.round(qty * 100) / 100;
          out.qtyUnknown = false;
        }
        const size = /(\d{3,4})\s*[×xх*]\s*(\d{3,4})/i.exec(f.size ?? '');
        if (size && out.gostProfile) out.gostProfile = { ...out.gostProfile, heightMm: Math.max(Number(size[1]), Number(size[2])), widthMm: Math.min(Number(size[1]), Number(size[2])) };
        if (size) out.size = `${Math.min(Number(size[1]), Number(size[2]))}×${Math.max(Number(size[1]), Number(size[2]))} мм`;
        return out;
      });
      // Подбор заново — по строкам без подтверждённой цены (интернет / ввод менеджера она не теряет).
      research.push(...items.filter((l) => mine(l) && !(l.price !== null && (l.priceSource === 'web_confirmed' || l.priceSource === 'manager'))).map((l) => l.request_index));
      break;
    }
    case 'delivery':
      next.delivery = answer.option === 'pickup' ? { mode: 'pickup', address: null, sum: null } : { mode: 'delivery', address: answer.fields?.address?.trim() || null, sum: Number((answer.fields?.sum ?? '').replace(/\s/g, '').replace(',', '.')) || null };
      break;
    case 'price_validity':
      next.priceValidity = answer.fields?.text?.trim() || null;
      break;
    case 'photo': {
      const name = key.slice('photo:'.length);
      next.photos = (payload.photos ?? []).map((p) => (p.name !== name ? p : answer.option === 'ignore' ? { ...p, ignored: true, requestIndex: null } : { ...p, ignored: false, requestIndex: Number(answer.option?.slice(4)) }));
      break;
    }
    case 'component_door':
      break;
  }
  next.items = items;
  return { payload: next, research: [...new Set(research)], candidates };
}

export const nonstandardLabel = (choice: NonstandardChoice) => `по прайсу, нестандарт: ${choice === 'computed' ? 'как посчитано' : choice === 'p30' ? '+30 %' : '+100 %'}`;

/**
 * «Собрать заново»: ответы прежнего черновика той же сделки — на новый (ключи стабильны), с их действием.
 * KB-MARKUP: ответ «нестандарт» вариантом прайса (как посчитано / +30 % / +100 %) переносится выбором, а не ценой — цену поиск
 * считает заново по текущему прайсу и наценке источника.
 */
export function carryAnswers(fresh: Partial<KpPayload>, previous: Partial<KpPayload> | null): Partial<KpPayload> {
  if (!previous?.answers) return fresh;
  let out: Partial<KpPayload> = { ...fresh, componentDoorGroups: { ...(previous.componentDoorGroups ?? {}), ...(fresh.componentDoorGroups ?? {}) } };
  for (const [key, a] of Object.entries(previous.answers)) {
    const choice = key.startsWith('nonstandard:') && (a.option === 'computed' || a.option === 'p30' || a.option === 'p100') ? (a.option as NonstandardChoice) : null;
    if (!choice) {
      out = applyAnswer(out, key, a).payload;
      continue;
    }
    out = applyAnswer(out, key, { ...a, price: null }).payload;
    const rowKey = key.slice(key.indexOf(':') + 1);
    const base = out;
    out = { ...out, items: (out.items ?? []).map((l) => (rowKeyOf(base, l) === rowKey && lineCategory(l) !== 'service' ? { ...l, nonstandardChoice: choice } : l)) };
  }
  return out;
}
