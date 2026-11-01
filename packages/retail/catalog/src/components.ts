/**
 * Комплектующие из карточки двери на rf-dveri.ru (RFD-AI-AGENT-KOMPLEKTUYUWIE).
 * Связка «дверь -> коробка/наличник/добор» не попадает ни в YML-фид, ни в /upage/<id>.json,
 * поэтому единственный источник - HTML карточки, блок ComponentsInTheFormOfTradeOffers.
 * У каждой двери свои варианты и свои цены - общие «Правила цен» дают неверную сумму.
 */

export interface DoorComponent {
  /** Группа без двоеточия: Коробка, Наличник, Добор, Карниз, Розетка, Цоколь, Плинтус и др. */
  group: string;
  name: string;
  pageId: number | null;
  offerId: number | null;
  price: number;
}

const BLOCK = 'ComponentsInTheFormOfTradeOffers';
const TITLE_RE = /class="Title[^"]*"[^>]*>\s*([^<]+)/;
const INPUT_RE = /<input\b[^>]*name="ComponentInTheFormOfTradeOffer[^>]*>/g;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(name + '="([^"]*)"').exec(tag);
  return m ? (m[1] ?? null) : null;
}

function clean(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Разбирает HTML карточки. Пустой массив - блока нет (товар без комплектующих), это не ошибка. */
export function parseDoorComponents(html: string): DoorComponent[] {
  const out: DoorComponent[] = [];
  const parts = html.split(BLOCK);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const title = TITLE_RE.exec(part);
    const group = title ? clean(title[1] ?? '').replace(/:$/, '') : '';
    if (!group) continue;
    for (const tag of part.match(INPUT_RE) ?? []) {
      const value = attr(tag, 'value') ?? '';
      if (!value) continue; // первый вариант группы - «не выбрано»
      const id = attr(tag, 'id');
      let name = '';
      if (id) {
        const esc = id.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
        const m = new RegExp('for="' + esc + '"[^>]*>\\s*([^<]{1,200})').exec(part);
        name = m ? clean(m[1] ?? '') : '';
      }
      const [pageRaw, offerRaw] = value.split('_');
      const price = Number(attr(tag, 'data-price') ?? '0');
      out.push({
        group,
        name,
        pageId: Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : null,
        offerId: Number.isFinite(Number(offerRaw)) ? Number(offerRaw) : null,
        price: Number.isFinite(price) ? price : 0,
      });
    }
  }
  return out;
}

/** Скачивает карточку и разбирает. Referer ставим свой - у антибота пустой referer уходит на проверку. */
export async function fetchDoorComponents(
  url: string,
  f: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<DoorComponent[]> {
  const res = await f(url, {
    headers: {
      'User-Agent': 'ai-door-agent/1.0 (+https://ai.rf-dveri.ru)',
      Referer: 'https://www.rf-dveri.ru/',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('Карточка ' + url + ': HTTP ' + String(res.status));
  return parseDoorComponents(await res.text());
}
