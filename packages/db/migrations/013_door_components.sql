-- Комплектующие конкретной двери из HTML карточки (RFD-AI-AGENT-KOMPLEKTUYUWIE):
-- у каждой двери свой набор и свои цены, общие «Правила цен» дают неверную сумму.
CREATE TABLE IF NOT EXISTS door_components (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  url text NOT NULL,
  group_name text NOT NULL,
  name text NOT NULL DEFAULT '',
  page_id bigint,
  offer_id bigint,
  price numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS door_components_product_idx ON door_components (account_id, product_id);

-- Отметка о последней попытке разбора: даёт TTL (не ходить на сайт на каждый ответ)
-- и счётчик карточек без связки — вёрстка сайта может поменяться.
CREATE TABLE IF NOT EXISTS door_components_state (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  url text NOT NULL,
  items integer NOT NULL DEFAULT 0,
  error text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, product_id)
);
