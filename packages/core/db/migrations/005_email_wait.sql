-- Письма от новых адресов, для которых ждём, пока встроенная почта amo создаст сделку.
CREATE TABLE email_waiting (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_address text NOT NULL,
  from_name    text NOT NULL DEFAULT '',
  subject      text NOT NULL DEFAULT '',
  text         text NOT NULL,
  meta         jsonb NOT NULL DEFAULT '{}',
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_waiting_account_idx ON email_waiting (account_id, received_at);
