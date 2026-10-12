-- БД «Агента опт» (ai_door_opt): свой набор миграций с нуля (ТЗ разделение, раздел 6.2).
-- Таблицы аккаунтов, токенов, секретов, журнала и документов повторяют DDL розницы
-- (миграции 001, 002, 006, 008, 009, 016), чтобы общие репозитории @core/db работали без правок.
-- Токены amoCRM у опта свои: это отдельная интеграция, копировать токены розницы запрещено.

CREATE TABLE accounts (
  id              bigint PRIMARY KEY,
  subdomain       text NOT NULL,
  account_domain  text NOT NULL,
  name            text,
  installed_at    timestamptz NOT NULL DEFAULT now(),
  uninstalled_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE amo_tokens (
  account_id          bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  access_token_enc    text NOT NULL,
  refresh_token_enc   text NOT NULL,
  expires_at          timestamptz NOT NULL,
  refreshed_at        timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  last_error_at       timestamptz
);
CREATE INDEX amo_tokens_expires_at_idx ON amo_tokens (expires_at);

-- Ключи провайдеров LLM и пароль SMTP (kind = openai | anthropic | smtp), зашифрованы.
CREATE TABLE account_secrets (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  value_enc   text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  PRIMARY KEY (account_id, kind)
);

CREATE TABLE llm_models_cache (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  models      jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider)
);

-- Настройки опта: модель, разбор файлов, письмо КП, курс. Версионируются как у розницы.
CREATE TABLE opt_settings (
  account_id  bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  settings    jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint
);

-- Журнал опта: kp_draft, kp_build, kp_sent, kp_error, document, note, error.
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
CREATE INDEX ai_journal_model_idx ON ai_journal (account_id, (details->>'provider'), (details->>'model'));

-- Разобранные спецификации из файлов сделки (@core/docs пишет сюда).
CREATE TABLE documents (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id       bigint,
  source        text NOT NULL CHECK (source IN ('chat', 'email', 'widget', 'sandbox')),
  filename      text,
  mime          text,
  size_bytes    integer NOT NULL DEFAULT 0,
  format        text NOT NULL,
  ocr           text,
  kind          text NOT NULL,
  data          jsonb NOT NULL,
  text_chars    integer NOT NULL DEFAULT 0,
  pii_removed   integer NOT NULL DEFAULT 0,
  model         text,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  created_by    bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_lead_idx ON documents (account_id, lead_id, created_at DESC);

-- Константы КП, шаблон и нумерация (переносятся из розницы скриптом на этапе 4).
CREATE TABLE kp_settings (
  account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  template_path text,
  template_name text,
  template_md5 text,
  template_updated_at timestamptz,
  constants jsonb NOT NULL DEFAULT '{}'::jsonb,
  certs_dir text,
  numbering jsonb NOT NULL DEFAULT '{"prefix": "КП", "year": null, "counter": 0}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Черновики КП: draft → built → sent, либо cancelled.
CREATE TABLE kp_drafts (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  docx_path text,
  pdf_path text,
  kp_no text,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  built_at timestamptz,
  sent_at timestamptz
);
CREATE INDEX kp_drafts_lead ON kp_drafts (account_id, lead_id, created_at DESC);
-- Номер выдаётся при первой удачной сборке и больше не меняется.
CREATE UNIQUE INDEX kp_drafts_no ON kp_drafts (account_id, kp_no) WHERE kp_no IS NOT NULL;
