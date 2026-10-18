-- RFD-AI-AGENT-OPT-KB-PRICE-SHEETS: многолистовой прайс — карточка товара по ID, сетка размеров, правила нестандарта,
-- словари, условия цены. Данные привязаны к файлу (source_id): удаление файла и повторная загрузка с тем же ключом
-- заменяют всё своё.
ALTER TABLE kb_prices
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS tariff_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'estimate_only')),
  ADD COLUMN IF NOT EXISTS estimate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS family text,
  ADD COLUMN IF NOT EXISTS applies_to text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS component_status jsonb,
  ADD COLUMN IF NOT EXISTS card jsonb;
CREATE INDEX IF NOT EXISTS kb_prices_product ON kb_prices (account_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kb_prices_tariff ON kb_prices (account_id, tariff_id) WHERE tariff_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kb_sizes (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL,
  source_id      bigint NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  product_id     text NOT NULL,
  size_id        text,
  width_mm       integer NOT NULL,
  height_mm      integer NOT NULL,
  basis          text,
  leaf_widths_mm jsonb
);
CREATE INDEX IF NOT EXISTS kb_sizes_product ON kb_sizes (account_id, product_id);

CREATE TABLE IF NOT EXISTS kb_rules (
  id                       bigserial PRIMARY KEY,
  account_id               bigint NOT NULL,
  source_id                bigint NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  price_key                text NOT NULL,
  large_threshold_percent  numeric NOT NULL DEFAULT 30,
  regular_surcharge_percent numeric NOT NULL DEFAULT 30,
  large_surcharge_percent  numeric NOT NULL DEFAULT 100,
  applies_to               text NOT NULL DEFAULT 'base',
  production_note          text
);
CREATE INDEX IF NOT EXISTS kb_rules_key ON kb_rules (account_id, price_key);

CREATE TABLE IF NOT EXISTS kb_dictionary (
  id         bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  source_id  bigint NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  sheet      text NOT NULL,
  term       text NOT NULL,
  term_key   text NOT NULL,
  meaning    text,
  context    text,
  rule       text
);
CREATE INDEX IF NOT EXISTS kb_dictionary_key ON kb_dictionary (account_id, term_key);

-- Синонимы из файла прайса привязаны к товару и уходят вместе с файлом.
ALTER TABLE kb_aliases ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE kb_aliases DROP CONSTRAINT IF EXISTS kb_aliases_source_id_fkey;
ALTER TABLE kb_aliases ADD CONSTRAINT kb_aliases_source_id_fkey FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE;
