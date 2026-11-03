-- Фаза 3: разобранные документы клиентов. Сами файлы не хранятся — только извлечённая структура.
CREATE TABLE documents (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id       bigint,
  source        text NOT NULL CHECK (source IN ('chat', 'email', 'widget', 'sandbox')),
  filename      text,
  mime          text,
  size_bytes    integer NOT NULL DEFAULT 0,
  format        text NOT NULL,
  ocr           text,                      -- провайдер OCR, если применялся
  kind          text NOT NULL,             -- measurement | request | estimate | catalog | photo | other
  data          jsonb NOT NULL,            -- DocumentData + matches
  text_chars    integer NOT NULL DEFAULT 0,
  pii_removed   integer NOT NULL DEFAULT 0,
  model         text,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  created_by    bigint,                    -- пользователь amo, если разбор запущен из виджета
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_lead_idx ON documents (account_id, lead_id, created_at DESC);
