-- RFD-AI-AGENT-DEAL-FILES: агент сам читает файлы, прикреплённые к сделке, и ссылки Яндекс Диска из примечаний.
-- mail_attachments.source — откуда файл: mail (письмо из ящика / через Salesbot), deal_file (файл сделки amo), yadisk (ссылка
-- Яндекс Диска). deal_file_links — ссылки из примечаний: статус, попытки, ошибка Диска (без повторов по 404). Только добавление.
ALTER TABLE mail_attachments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mail';
CREATE INDEX IF NOT EXISTS mail_attachments_lead_source ON mail_attachments (account_id, lead_id, source, created_at);

CREATE TABLE IF NOT EXISTS deal_file_links (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL,
  lead_id     bigint NOT NULL,
  note_id     bigint,
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  attempts    integer NOT NULL DEFAULT 0,
  files       integer NOT NULL DEFAULT 0,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, lead_id, url)
);
