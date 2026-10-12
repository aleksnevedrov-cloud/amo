import { describe, expect, it } from 'vitest';
import { parseDoorComponents } from '../src/components.ts';

/** Фрагмент карточки rf-dveri.ru: две группы комплектующих. */
const html = [
  '<div class="ComponentsInTheFormOfTradeOffers">',
  '<div class="Title FBB_CA">Коробка:</div>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer1" id="k0" value="" data-price="0">',
  '<label for="k0">не выбрано</label>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer1" id="k1" value="91234_5678" data-price="1156">',
  '<label for="k1">Стандартная 2080x70x26</label>',
  '</div>',
  '<div class="ComponentsInTheFormOfTradeOffers">',
  '<div class="Title FBB_CA">Наличник:</div>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer2" id="n0" value="" data-price="0">',
  '<label for="n0">не выбрано</label>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer2" id="n1" value="91235_5679" data-price="390">',
  '<label for="n1">Прямой 2150x70x8</label>',
  '</div>',
].join('\n');

describe('разбор комплектующих из карточки двери', () => {
  const items = parseDoorComponents(html);

  it('берёт все группы и пропускает вариант «не выбрано»', () => {
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.group)).toEqual(['Коробка', 'Наличник']);
  });

  it('читает название и цену варианта', () => {
    const korobka = items.find((i) => i.group === 'Коробка');
    expect(korobka?.name).toBe('Стандартная 2080x70x26');
    expect(korobka?.price).toBe(1156);
    expect(korobka?.pageId).toBe(91234);
    expect(korobka?.offerId).toBe(5678);
  });

  it('нет блока — пустой список, это не ошибка', () => {
    expect(parseDoorComponents('<html><body>без комплектующих</body></html>')).toEqual([]);
  });
});
