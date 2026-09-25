import type { PositionFlag } from './match.ts';
import type { DocumentResult } from './service.ts';

export const KIND_LABEL: Record<string, string> = {
  measurement: 'Замерный лист',
  request: 'Запрос / спецификация',
  estimate: 'Смета / КП',
  catalog: 'Каталог',
  photo: 'Фото',
  other: 'Документ',
};

const FLAG_LABEL: Record<PositionFlag, string> = {
  fireproof: 'противопожарная — не ассортимент',
  steel: 'стальная/алюминиевая — под заказ',
  nonstandard_size: 'нестандартный размер',
  not_found: 'в каталоге не найдено',
};

const size = (w: number | null, h: number | null) => (w || h ? `${w ?? '?'}×${h ?? '?'} мм` : '');

/** Компактно для контекста агента: факты из файла, без лишних слов. */
export function documentToText(r: Omit<DocumentResult, 'text' | 'note'>, filename: string): string {
  const d = r.data;
  const lines = [`[Файл «${filename}»: ${KIND_LABEL[d.kind] ?? d.kind}] ${d.summary}`];
  if (d.customer_type === 'b2b') lines.push('Похоже на запрос от организации (юрлицо/тендер).');
  if (d.openings.length) {
    lines.push('Проёмы:');
    for (const o of d.openings.slice(0, 30)) {
      lines.push(
        `- ${[o.label, o.room].filter(Boolean).join(' ')}${o.label || o.room ? ': ' : ''}${size(o.width_mm, o.height_mm)}${o.wall_mm ? `, стена ${o.wall_mm} мм` : ''}${o.qty && o.qty > 1 ? `, ${o.qty} шт.` : ''}${o.double ? ', двустворчатая' : ''}${o.side ? `, ${o.side === 'left' ? 'левая' : 'правая'}` : ''}${o.note ? ` (${o.note})` : ''}`,
      );
    }
  }
  if (d.positions.length) {
    lines.push(`Позиции (${d.positions.length}):`);
    for (const [i, p] of d.positions.slice(0, 30).entries()) {
      const m = r.matches.find((x) => x.index === i);
      const flags = (m?.flags ?? []).map((f) => FLAG_LABEL[f]).join('; ');
      const found = m?.products.length ? `похоже: ${m.products.map((x) => `${x.name}${x.price ? ` ${x.price} ₽` : ''} (id ${x.id})`).join(', ')}` : '';
      lines.push(`- ${p.name}${p.marking ? ` [${p.marking}]` : ''} ${size(p.width_mm, p.height_mm)}${p.qty ? ` — ${p.qty} ${p.unit ?? 'шт.'}` : ''}${p.price_rub ? `, цена в документе ${p.price_rub} ₽` : ''}${[flags, found].filter(Boolean).length ? ` — ${[flags, found].filter(Boolean).join('; ')}` : ''}`);
    }
    if (d.positions.length > 30) lines.push(`…и ещё ${d.positions.length - 30}`);
  }
  if (r.kit) {
    const t = r.kit.totals;
    lines.push(`Комплект по замеру: полотен ${t.doors}, коробок ${t.boxes}, наличников ${t.casings}, доборов ${t.extensions}.`);
    const ns = r.kit.lines.filter((l) => l.nonstandard);
    if (ns.length) lines.push(`Нестандартные полотна: ${ns.map((l) => `${l.opening} ${l.leaf_width_mm ?? '?'}×${l.leaf_height_mm ?? '?'}`).join('; ')}.`);
  }
  if (d.photo) lines.push(`Фото: ${[d.photo.subject, d.photo.door_type, d.photo.color, d.photo.style, d.photo.note].filter(Boolean).join(', ')}`);
  if (d.requirements.length) lines.push(`Условия из документа: ${d.requirements.slice(0, 10).join('; ')}`);
  if (d.questions.length) lines.push(`Уточнить: ${d.questions.slice(0, 8).join('; ')}`);
  return lines.join('\n');
}

/** Примечание в сделку для менеджера. */
export function documentToNote(r: Omit<DocumentResult, 'text' | 'note'>, filename: string): string {
  const d = r.data;
  const lines = [`[AI] Разбор файла «${filename}» — ${KIND_LABEL[d.kind] ?? d.kind}`, d.summary, ''];
  if (d.openings.length) {
    lines.push('Проёмы:');
    for (const [i, o] of d.openings.entries()) {
      const k = r.kit?.lines[i];
      lines.push(
        `${i + 1}. ${[o.label, o.room].filter(Boolean).join(' ') || 'проём'}: ${size(o.width_mm, o.height_mm)}${o.wall_mm ? `, стена ${o.wall_mm}` : ''}${o.qty && o.qty > 1 ? `, ${o.qty} шт.` : ''}${o.double ? ', двустворчатая' : ''}${o.side ? `, ${o.side === 'left' ? 'лев.' : 'прав.'}` : ''}${k?.leaf_width_mm ? ` → полотно ${k.leaf_width_mm}×${k.leaf_height_mm ?? '?'}${k.nonstandard ? ' (нестандарт)' : ''}` : ''}${o.note ? `. ${o.note}` : ''}`,
      );
    }
    if (r.kit) {
      const t = r.kit.totals;
      lines.push('', `Комплект: полотен ${t.doors}, коробок ${t.boxes}, наличников ${t.casings}, доборов ${t.extensions}${r.kit.lines.some((l) => l.extension_width_mm) ? ` (${[...new Set(r.kit.lines.map((l) => l.extension_width_mm).filter(Boolean))].join('/')} мм)` : ''}.`);
    }
  }
  if (d.positions.length) {
    lines.push('Позиции:');
    for (const [i, p] of d.positions.entries()) {
      const m = r.matches.find((x) => x.index === i);
      const flags = (m?.flags ?? []).map((f) => FLAG_LABEL[f]).join(', ');
      lines.push(`${i + 1}. ${p.name}${p.marking ? ` [${p.marking}]` : ''} ${size(p.width_mm, p.height_mm)}${p.qty ? ` — ${p.qty} ${p.unit ?? 'шт.'}` : ''}${p.price_rub ? `, ${p.price_rub} ₽` : ''}${p.color ? `, ${p.color}` : ''}${flags ? ` — ${flags}` : ''}${m?.products.length ? `; похоже: ${m.products.map((x) => x.name).join(', ')}` : ''}`);
    }
  }
  if (d.requirements.length) lines.push('', 'Условия:', ...d.requirements.map((x) => `• ${x}`));
  if (d.questions.length) lines.push('', 'Уточнить у клиента:', ...d.questions.map((x) => `• ${x}`));
  if (d.photo) lines.push('', `Фото: ${[d.photo.subject, d.photo.door_type, d.photo.color, d.photo.style, d.photo.note].filter(Boolean).join(', ')}`);
  return lines.join('\n').trim();
}
