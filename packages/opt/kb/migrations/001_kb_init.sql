-- База знаний «Агента опт» (RFD-AI-AGENT-OPT-KB, этап 1): отдельная БД ai_door_opt_kb в контейнере opt-kb-db
-- (pgvector/pgvector:pg16). Ни розница, ни БД опта ai_door_opt сюда не ходят; account_id — id аккаунта amoCRM без FK.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- Источники: файл, ссылка, текст менеджера.
CREATE TABLE kb_sources (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('file', 'url', 'text')),
  title           text NOT NULL,
  -- Оригинал: имя загруженного файла или адрес; у текста — NULL.
  original        text,
  -- Копия на томе opt-kb-files (KB_FILES_ROOT/<account_id>/…): файл, текст заметки, скачанная страница — для переиндексации.
  file_path       text,
  mime            text,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'indexed', 'error')),
  size_bytes      bigint NOT NULL DEFAULT 0,
  chunks          integer NOT NULL DEFAULT 0,
  -- Фрагментов с эмбеддингом: 0 — ключа OpenAI не было, работает только полнотекстовый поиск.
  embedded_chunks integer NOT NULL DEFAULT 0,
  -- Период обновления для ссылок, дни (этап 2); NULL — не обновлять.
  refresh_days    integer,
  next_refresh_at timestamptz,
  error           text,
  created_by      bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  indexed_at      timestamptz
);
CREATE INDEX kb_sources_account ON kb_sources (account_id, created_at DESC);
CREATE INDEX kb_sources_refresh ON kb_sources (next_refresh_at) WHERE next_refresh_at IS NOT NULL;

-- Фрагменты текста (≤ 1 500 символов) с эмбеддингом text-embedding-3-small (1536) и полнотекстовым индексом.
CREATE TABLE kb_chunks (
  id          bigserial PRIMARY KEY,
  source_id   bigint NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  account_id  bigint NOT NULL,
  position    integer NOT NULL,
  text        text NOT NULL CHECK (char_length(text) <= 1500),
  embedding   vector(1536),
  -- Страница PDF, лист xlsx, заголовок раздела.
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('russian', text)) STORED
);
CREATE INDEX kb_chunks_source ON kb_chunks (source_id, position);
CREATE INDEX kb_chunks_account ON kb_chunks (account_id);
CREATE INDEX kb_chunks_tsv ON kb_chunks USING gin (tsv);
CREATE INDEX kb_chunks_trgm ON kb_chunks USING gin (text gin_trgm_ops);
CREATE INDEX kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops);

-- Структурные записи цен из источников (этап 3): модель, фабрика, единица, базовый размер, цена, НДС, дата, доверие, правила нестандарта.
CREATE TABLE kb_prices (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL,
  source_id    bigint REFERENCES kb_sources(id) ON DELETE SET NULL,
  model        text NOT NULL,
  -- Нормализованная модель (нижний регистр, ё→е, одиночные пробелы) — ключ поиска.
  model_key    text NOT NULL,
  factory      text,
  unit         text NOT NULL DEFAULT 'шт',
  base_size    text,
  width_mm     integer,
  height_mm    integer,
  price        numeric(12, 2) NOT NULL,
  -- included — с НДС, no_vat — без НДС, unknown — не указано.
  vat          text NOT NULL DEFAULT 'unknown' CHECK (vat IN ('included', 'no_vat', 'unknown')),
  valid_at     date NOT NULL,
  confidence   integer NOT NULL DEFAULT 60 CHECK (confidence BETWEEN 0 AND 100),
  -- price_list — прайс из источника, web — веб-поиск (доверие 40), manager — правка менеджера (90), purchase — закупка.
  origin       text NOT NULL CHECK (origin IN ('price_list', 'web', 'manager', 'purchase')),
  -- Правила нестандарта: доплаты за высоту, ширину, толщину, двупольный — {heightPct, widthPct, thicknessPct, doubleLeafPct, …}.
  nonstandard  jsonb NOT NULL DEFAULT '{}'::jsonb,
  url          text,
  note         text,
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_prices_model ON kb_prices (account_id, model_key, valid_at DESC);
CREATE INDEX kb_prices_source ON kb_prices (source_id);
CREATE INDEX kb_prices_model_trgm ON kb_prices USING gin (model_key gin_trgm_ops);

-- Синонимы и артикулы: «ДПГ сота» = «ДПГ + УПД (сота)» = «дверь глухая ламинированная сотовое заполнение».
CREATE TABLE kb_aliases (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL,
  alias          text NOT NULL,
  alias_key      text NOT NULL,
  canonical      text NOT NULL,
  canonical_key  text NOT NULL,
  source_id      bigint REFERENCES kb_sources(id) ON DELETE SET NULL,
  created_by     bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, alias_key)
);
CREATE INDEX kb_aliases_canonical ON kb_aliases (account_id, canonical_key);
