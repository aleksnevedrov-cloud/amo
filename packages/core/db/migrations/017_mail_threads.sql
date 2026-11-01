-- Нить письма клиента: ответ с КП уходит в ту же цепочку (тема RFD-AI-AGENT-KP, этап 5).
CREATE TABLE IF NOT EXISTS mail_threads (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id bigint NOT NULL,
  message_id text,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  from_addr text NOT NULL,
  from_name text,
  subject text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_threads_lead
  ON mail_threads (account_id, lead_id, received_at DESC);
