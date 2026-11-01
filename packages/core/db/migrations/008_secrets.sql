-- Фаза 5: секреты аккаунта (ключ Anthropic и т. п.) — каждая компания из Маркетплейса вводит свой ключ.
-- Значение зашифровано AES-256-GCM тем же ключом, что токены amo; через API не читается.
CREATE TABLE account_secrets (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  value_enc   text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint,
  PRIMARY KEY (account_id, kind)
);
