-- RFD-AI-AGENT-OPT-PRICE, этап 3: результаты поиска рыночных цен по позициям КП и кэш по запросу.
-- Только БД опта (ai_door_opt); розницу не касается.
CREATE TABLE kp_price_research (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Черновик, из которого запущен поиск; при удалении черновика результат остаётся (кэш).
  draft_id bigint REFERENCES kp_drafts(id) ON DELETE SET NULL,
  request_index int NOT NULL DEFAULT 0,
  -- Фактический поисковый запрос и его нормализованный вид (нижний регистр, ё→е, одиночные пробелы) — ключ кэша.
  query text NOT NULL,
  query_key text NOT NULL,
  -- Ключ по тексту позиции (наименование + размер): кэш срабатывает до вызова модели за карточкой.
  item_key text NOT NULL DEFAULT '',
  card jsonb,
  status text NOT NULL,
  offers jsonb NOT NULL DEFAULT '[]'::jsonb,
  stats jsonb,
  analog jsonb,
  error text,
  provider text,
  model text,
  web_search_calls int NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kp_price_research_draft ON kp_price_research (account_id, draft_id);
CREATE INDEX kp_price_research_query ON kp_price_research (account_id, query_key, created_at DESC);
CREATE INDEX kp_price_research_item ON kp_price_research (account_id, item_key, created_at DESC);
