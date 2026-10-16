-- RFD-AI-AGENT-OPT-KB-MATCH: подбор цены по признакам двери (тип, материал, глухая/остеклённая, створки, порог,
-- открывание, покрытие, огнестойкость, доводчик, замок). Признаки хранятся у записи (jsonb) и ключ группы по
-- обязательным признакам — для медианы прайса по группе (проверка реалистичности веб-цен).
-- Старые записи (features IS NULL) получают признаки при старте opt-api (backfillFeatures) из текста модели/назначения;
-- веб-записи с названием из письма из подбора вытесняются строкой прайса по признакам порядком источников.
ALTER TABLE kb_prices
  ADD COLUMN IF NOT EXISTS features    jsonb,
  ADD COLUMN IF NOT EXISTS feature_key text;
CREATE INDEX IF NOT EXISTS kb_prices_feature_key ON kb_prices (account_id, feature_key) WHERE feature_key IS NOT NULL;
