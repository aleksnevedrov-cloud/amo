import type { KnowledgeSet } from './repo.ts';

/**
 * Подмешивание справочников в черновик КП как исходных данных (ТЗ разделение, раздел 9).
 * Справочники дают менеджеру подсказки у позиций и у черновика в целом; цифры из них в строки КП
 * не подставляются автоматически — цену строки выбирает менеджер. Пустые справочники не дают ничего:
 * черновик собирается ровно так же, как без базы знаний.
 */

export interface KnowledgeHintInput {
  items: { request_index: number; name: string; raw?: string }[];
  requiredBlocks: string[];
  /** Текст письма и позиций — для поиска слов из стоп-листа и признаков доставки/монтажа. */
  text: string;
  /** Юрлицо: есть организация у покупателя. */
  isLegalEntity: boolean;
}

export interface KnowledgeHint {
  request_index: number;
  reason: string;
}

export interface KnowledgeSummary {
  delivery: number;
  installation: number;
  b2b: number;
  analogs: number;
  stoplist: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

export function knowledgeSummary(k: KnowledgeSet): KnowledgeSummary {
  return { delivery: k.delivery.length, installation: k.installation.length, b2b: k.b2b?.sections.length ?? 0, analogs: k.analogs.length, stoplist: k.stoplist.length };
}

export function knowledgeHints(input: KnowledgeHintInput, k: KnowledgeSet): KnowledgeHint[] {
  const hints: KnowledgeHint[] = [];
  const text = norm(input.text);

  // Стоп-лист: правило срабатывает по ключевым словам в позиции, иначе — в письме целиком.
  for (const rule of k.stoplist) {
    const words = rule.keywords.split(',').map((w) => norm(w).trim()).filter(Boolean);
    if (!words.length) continue;
    const hit = input.items.filter((it) => words.some((w) => norm(`${it.name} ${it.raw ?? ''}`).includes(w)));
    for (const it of hit) hints.push({ request_index: it.request_index, reason: `стоп-лист (${rule.topic}): ${rule.rule}` });
    if (!hit.length && words.some((w) => text.includes(w))) hints.push({ request_index: -1, reason: `стоп-лист (${rule.topic}): ${rule.rule}` });
  }

  // Аналоги: позиция упоминает фабрику и модель (или только модель) из справочника.
  for (const a of k.analogs) {
    const model = norm(a.model);
    const factory = norm(a.factory);
    for (const it of input.items) {
      const name = norm(`${it.name} ${it.raw ?? ''}`);
      if (name.includes(model) && (name.includes(factory) || model.length >= 4)) {
        hints.push({ request_index: it.request_index, reason: `аналог по справочнику: ${a.analogFactory} ${a.analogModel}${a.note ? ` (${a.note})` : ''}` });
      }
    }
  }

  if (k.delivery.length && (input.requiredBlocks.includes('delivery') || text.includes('доставк'))) {
    hints.push({ request_index: -1, reason: `доставка: в справочнике ${k.delivery.length} зон — добавьте строку по адресу клиента` });
  }
  if (k.installation.length && /монтаж|замер|установк/.test(text)) {
    hints.push({ request_index: -1, reason: `замер и монтаж: в справочнике ${k.installation.length} услуг — добавьте нужные строки` });
  }
  if (k.b2b && input.isLegalEntity) {
    hints.push({ request_index: -1, reason: `юрлицо: сверьтесь с регламентом (${k.b2b.sections.map((s) => s.title).join('; ')})` });
  }
  return hints;
}
