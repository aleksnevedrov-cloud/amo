-- RFD-AI-AGENT-OPT-KB-PRICELIST: прайс — единый источник цен.
-- е) сироты прайса (файл удалён, source_id → NULL) удаляются: они конфликтовали по kb_prices_key с новым прайсом,
--    и удаление следующего файла падало с 500 «duplicate key».
DELETE FROM kb_prices WHERE source_id IS NULL AND origin = 'price_list';
-- а) удаление файла удаляет его цены: ON DELETE CASCADE вместо SET NULL. Ручные правки и веб-цены источника не имеют.
ALTER TABLE kb_prices DROP CONSTRAINT IF EXISTS kb_prices_source_id_fkey;
ALTER TABLE kb_prices ADD CONSTRAINT kb_prices_source_id_fkey FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE;
-- г) дополнительные ключи подбора: «Сокращение в названии» (abbr), «Назначение/Конструкция» (description),
--    их ключи (alt_keys) и слова для подбора по словам (search_tokens); строка прайса — для подписи «строка 17».
ALTER TABLE kb_prices
  ADD COLUMN IF NOT EXISTS abbr          text,
  ADD COLUMN IF NOT EXISTS description   text,
  ADD COLUMN IF NOT EXISTS alt_keys      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS search_tokens text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source_row    integer;
CREATE INDEX IF NOT EXISTS kb_prices_alt_keys ON kb_prices USING gin (alt_keys);
CREATE INDEX IF NOT EXISTS kb_prices_search_tokens ON kb_prices USING gin (search_tokens);
-- Слова для подбора у существующих записей — из ключа модели.
UPDATE kb_prices SET search_tokens = string_to_array(model_key, ' ') WHERE cardinality(search_tokens) = 0 AND model_key <> '';
