-- KB-PRICE-SHEETS-FIX: в многолистовом прайсе две модели с одинаковым названием («ДПГ усиленная» ПВХ и Шпон) — разные ID товара;
-- ключ записи цены дополняется ID товара и ID тарифа, иначе вторая строка затирала первую (25 дверей вместо 30).
DROP INDEX IF EXISTS kb_prices_key;
CREATE UNIQUE INDEX kb_prices_key ON kb_prices (account_id, model_key, coalesce(base_size, ''), origin, coalesce(source_id, 0), coalesce(product_id, ''), coalesce(tariff_id, ''));
