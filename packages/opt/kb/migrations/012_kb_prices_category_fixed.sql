-- KB-HW-NULL-2: категорию строки, которую задал импорт (вкладка «Дополнения» — фурнитура, лист 1 — дверь, колонки компонентов —
-- комплектующее), opt-api при старте больше не пересчитывает по словам названия. До этой миграции пересчёт при каждом старте
-- переводил тарифы «Дополнений» («Санузловой МДФ…», «Алюминиевый блок…», «Стекло СМ4…», «ECO SLIDING SET 1» …) в двери.
ALTER TABLE kb_prices ADD COLUMN IF NOT EXISTS category_fixed boolean NOT NULL DEFAULT false;

-- Тарифы «Дополнений»: всегда фурнитура; ID товара = ID тарифа (OPT-0xx) — для сверки между файлами, «Для моделей» и пометок.
UPDATE kb_prices SET category = 'hardware', component_kind = NULL, product_id = tariff_id, updated_at = now()
 WHERE origin = 'price_list' AND tariff_id IS NOT NULL AND (category <> 'hardware' OR product_id IS DISTINCT FROM tariff_id);

-- Комплектующие с листа 1 многолистового прайса («Коробка (ДПГ CPL)», описание «комплектующее к …»).
UPDATE kb_prices SET category = 'component',
       component_kind = CASE lower(split_part(model, ' ', 1)) WHEN 'коробка' THEN 'коробка' WHEN 'наличник' THEN 'наличник' WHEN 'добор' THEN 'добор' WHEN 'порог' THEN 'порог' ELSE component_kind END,
       updated_at = now()
 WHERE origin = 'price_list' AND tariff_id IS NULL AND product_id IS NOT NULL AND description LIKE 'комплектующее к %' AND category <> 'component';

-- Двери с листа 1 многолистового прайса (есть ID товара, нет ID тарифа, не комплектующее).
UPDATE kb_prices SET category = 'door', component_kind = NULL, updated_at = now()
 WHERE origin = 'price_list' AND tariff_id IS NULL AND product_id IS NOT NULL AND (description IS NULL OR description NOT LIKE 'комплектующее к %') AND category <> 'door';

-- Категория всех строк прайса задана импортом — дальше она фиксирована.
UPDATE kb_prices SET category_fixed = true WHERE origin = 'price_list';
