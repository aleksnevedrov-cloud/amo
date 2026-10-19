-- KB-HW-NULL: фурнитура из «Дополнений» без цены (статус not_priced, OPT-009…017) хранилась как 0,00 — теперь цены нет (NULL).
-- 0 в базе выглядел как цена: тянул вниз медиану фурнитуры для проверки веб-цен и показывался «0 ₽» в списке цен и выгрузке.
ALTER TABLE kb_prices ALTER COLUMN price DROP NOT NULL;
-- Любая строка прайса с нулевой (или отрицательной) ценой — это «цены нет»; веб-цены и правки менеджера не трогаются.
UPDATE kb_prices SET price = NULL, updated_at = now() WHERE origin = 'price_list' AND price <= 0;
-- Дальше у строки прайса цена либо больше нуля, либо её нет.
ALTER TABLE kb_prices ADD CONSTRAINT kb_prices_price_positive CHECK (price IS NULL OR price > 0 OR origin <> 'price_list');
