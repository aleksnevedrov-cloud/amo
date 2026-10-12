-- Аккаунты amoCRM, установившие интеграцию. id = account_id в amo.
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

-- OAuth-токены amo, зашифрованы AES-256-GCM (см. @ai-door/shared SecretBox).
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

-- Настройки виджета (JSON по схеме из @ai-door/db settings.ts).
CREATE TABLE widget_settings (
  account_id  bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  settings    jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint
);

-- Аудит изменений настроек (раздел 12 ТЗ).
CREATE TABLE settings_audit (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     bigint,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  before      jsonb,
  after       jsonb NOT NULL
);
CREATE INDEX settings_audit_account_idx ON settings_audit (account_id, changed_at DESC);
