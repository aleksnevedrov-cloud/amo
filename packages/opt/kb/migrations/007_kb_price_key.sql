-- RFD-AI-AGENT-OPT-KB-MULTIPRICE: несколько прайсов на аккаунт. Ключ прайса — нормализованное имя файла без расширения
-- и суффиксов версий/дат; загрузка файла с тем же ключом заменяет только его цены. price_import — итог последнего импорта
-- (было/стало/удалено/добавлено) для карточки источника. Ключи у существующих прайсов заполняет opt-api при старте.
ALTER TABLE kb_sources
  ADD COLUMN IF NOT EXISTS price_key text,
  ADD COLUMN IF NOT EXISTS price_import jsonb;
CREATE INDEX IF NOT EXISTS kb_sources_price_key ON kb_sources (account_id, price_key) WHERE price_key IS NOT NULL;
