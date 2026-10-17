-- RFD-AI-AGENT-OPT-KB-COMPONENTS: категория записи цены — дверь / комплектующее / фурнитура / работы. Подбор идёт внутри
-- категории позиции; медиана для фильтра реалистичности веб-цен — по категории. У существующих записей категорию по тексту
-- модели проставляет opt-api при старте.
ALTER TABLE kb_prices
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'door' CHECK (category IN ('door', 'component', 'hardware', 'service')),
  ADD COLUMN IF NOT EXISTS component_kind text;
CREATE INDEX IF NOT EXISTS kb_prices_category ON kb_prices (account_id, category);
