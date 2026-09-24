-- Фаза 1: каталог, база знаний, диалоги, журнал AI.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE catalog_categories (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id          text NOT NULL,
  parent_id   text,
  name        text NOT NULL,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE catalog_products (
  account_id     bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id             text NOT NULL,              -- offer id из фида
  name           text NOT NULL,
  url            text,
  price          numeric(12, 2),
  old_price      numeric(12, 2),
  currency       text,
  available      boolean,
  category_id    text,
  category_path  text,
  vendor         text,
  vendor_code    text,
  description    text,
  params         jsonb NOT NULL DEFAULT '[]',
  pictures       text[] NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', coalesce(name, '') || ' ' || coalesce(vendor_code, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(category_path, '') || ' ' || coalesce(vendor, '')), 'B') ||
    setweight(to_tsvector('russian', coalesce(params::text, '')), 'C') ||
    setweight(to_tsvector('russian', coalesce(description, '')), 'D')
  ) STORED,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX catalog_products_search_idx ON catalog_products USING gin (search);
CREATE INDEX catalog_products_name_trgm_idx ON catalog_products USING gin (lower(name) public.gin_trgm_ops);
CREATE INDEX catalog_products_code_idx ON catalog_products (account_id, lower(vendor_code));

CREATE TABLE catalog_imports (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source       text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  products     integer,
  categories   integer,
  error        text
);
CREATE INDEX catalog_imports_account_idx ON catalog_imports (account_id, started_at DESC);

-- База знаний: исходные материалы и фрагменты для поиска.
CREATE TABLE knowledge_items (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('faq', 'text', 'url', 'file')),
  title       text NOT NULL,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint
);
CREATE INDEX knowledge_items_account_idx ON knowledge_items (account_id, created_at DESC);

CREATE TABLE knowledge_chunks (
  id          bigserial PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  account_id  bigint NOT NULL,
  position    integer NOT NULL,
  content     text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('russian', content)) STORED
);
CREATE INDEX knowledge_chunks_search_idx ON knowledge_chunks USING gin (search);
CREATE INDEX knowledge_chunks_account_idx ON knowledge_chunks (account_id);

-- Состояние AI по сделке.
CREATE TABLE conversations (
  account_id    bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id       bigint NOT NULL,
  paused        boolean NOT NULL DEFAULT false,
  pause_reason  text,
  paused_at     timestamptz,
  misses        integer NOT NULL DEFAULT 0,
  last_ai_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, lead_id)
);

-- Переписка, которую видел AI (первоисточник — amo).
CREATE TABLE dialog_messages (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id     bigint NOT NULL,
  role        text NOT NULL CHECK (role IN ('client', 'ai', 'manager')),
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dialog_messages_lead_idx ON dialog_messages (account_id, lead_id, id);

-- Входящие сообщения, ожидающие обработки (склейка серии сообщений).
CREATE TABLE pending_messages (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id       bigint NOT NULL,
  text          text NOT NULL,
  return_url    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX pending_messages_open_idx ON pending_messages (account_id, lead_id) WHERE processed_at IS NULL;

-- Журнал действий AI со стоимостью.
CREATE TABLE ai_journal (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id        bigint,
  kind           text NOT NULL,
  summary        text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}',
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       numeric(12, 6) NOT NULL DEFAULT 0,
  cost_rub       numeric(12, 2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_journal_account_idx ON ai_journal (account_id, created_at DESC);
CREATE INDEX ai_journal_lead_idx ON ai_journal (account_id, lead_id, created_at DESC);
