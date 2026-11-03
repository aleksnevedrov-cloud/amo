-- Фаза 2: правила цен, память клиента, черновики и подсказки, вложения.

-- Правила расчёта стоимости (схема — @ai-door/pricing). Отдельно от настроек: могут быть большими.
CREATE TABLE pricing_rules (
  account_id  bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  rules       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint
);

-- Память о клиенте: по контакту amo (или по сделке, если контакта нет).
CREATE TABLE client_memory (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject     text NOT NULL,             -- 'contact:<id>' | 'lead:<id>'
  data        jsonb NOT NULL DEFAULT '{}',
  summary     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject)
);

-- Черновики (режим «Полуавто») и подсказки менеджеру.
CREATE TABLE ai_suggestions (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id      bigint NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('draft', 'hint')),
  text         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'sent', 'rejected', 'used', 'expired')),
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   bigint
);
CREATE INDEX ai_suggestions_lead_idx ON ai_suggestions (account_id, lead_id, id DESC);
CREATE INDEX ai_suggestions_pending_idx ON ai_suggestions (account_id, status) WHERE status IN ('pending', 'approved');

-- Вложения входящих сообщений (голосовые и файлы).
ALTER TABLE pending_messages ADD COLUMN attachment_url text, ADD COLUMN attachment_type text;
