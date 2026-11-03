import { describe, expect, it } from 'vitest';
import { categoryOf, componentColumnKind, componentKindOf, defaultCategoryOfPriceKey, detectCategory } from '../src/category.ts';

describe('категория позиции (RFD-AI-AGENT-OPT-KB-COMPONENTS)', () => {
  it('дверь / комплектующее / фурнитура / работы — по первому ключевому слову', () => {
    expect(detectCategory('Дверной блок деревянный глухой CPL')).toBe('door');
    expect(detectCategory('ДПГ + УПД, сота 2000×800')).toBe('door');
    expect(detectCategory('Дверной блок с коробкой и наличниками')).toBe('door');
    expect(detectCategory('Коробка дверная телескопическая МДФ')).toBe('component');
    expect(detectCategory('Добор телескопический, МДФ, 300×2150')).toBe('component');
    expect(detectCategory('Наличник прямой 70 мм')).toBe('component');
    expect(detectCategory('Порог дверной дуб')).toBe('component');
    expect(detectCategory('Ручка дверная Palladium на розетке')).toBe('hardware');
    expect(detectCategory('Замок врезной межкомнатный')).toBe('hardware');
    expect(detectCategory('Цилиндровый механизм 35×35')).toBe('hardware');
    expect(detectCategory('Петля универсальная 100×70')).toBe('hardware');
    expect(detectCategory('Доводчик дверной Dorma')).toBe('hardware');
    expect(detectCategory('Накладки на цилиндр')).toBe('hardware');
    expect(detectCategory('Монтаж дверного блока')).toBe('service');
    expect(detectCategory('Врезка замка на производстве')).toBe('service');
    expect(detectCategory('Доставка по Москве')).toBe('service');
    expect(detectCategory('Разгрузка')).toBe('service');
    // Слова работ и фурнитуры в середине описания двери категорию не меняют (сделка 30008823: «…/врезка замка под цилиндр…»).
    expect(detectCategory('Аква 01 ПГ + УПД 600*2000*40 мм окут Белый ПВХ/врезка замка под цилиндр кл/зв/Правая (Дб-9')).toBe('door');
    expect(detectCategory('Турин белая с замком и петлями')).toBeNull();
    expect(detectCategory('Комплект наличников телескопических')).toBe('component');
    expect(detectCategory('Турин')).toBeNull();
    expect(categoryOf('Турин')).toBe('door');
    expect(categoryOf('Palladium A-1', 'hardware')).toBe('hardware');
  });

  it('вид комплектующего, колонки прайса, категория по имени файла', () => {
    expect(componentKindOf('Добор телескопический, МДФ')).toBe('добор');
    expect(componentKindOf('Коробка дверная')).toBe('коробка');
    expect(componentKindOf('Дверной блок')).toBeNull();
    expect(componentColumnKind('Коробка, руб.')).toBe('коробка');
    expect(componentColumnKind('Наличник')).toBe('наличник');
    expect(componentColumnKind('Добор, руб. с НДС')).toBe('добор');
    expect(componentColumnKind('Порог')).toBe('порог');
    expect(componentColumnKind('Цена, руб.')).toBeNull();
    expect(defaultCategoryOfPriceKey('прайс фурнитура 2026')).toBe('hardware');
    expect(defaultCategoryOfPriceKey('прайс межкомнатные двери гост')).toBe('door');
    expect(defaultCategoryOfPriceKey(null)).toBe('door');
  });
});
