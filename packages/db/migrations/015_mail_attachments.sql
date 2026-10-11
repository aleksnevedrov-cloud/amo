-- Вложения входящих писем: файл на диске, строка здесь, копия в карточке сделки amoCRM.
-- Тема RFD-AI-AGENT-KP, этап 1.
CREATE TABLE IF NOT EXISTS mail_attachments (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id bigint,
  message_uid bigint,
  message_id text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  storage_path text NOT NULL,
  amo_file_uuid text,
  amo_error text,
  extracted_text text,
  extract_status text NOT NULL DEFAULT 'pending',
  extract_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  extracted_at timestamptz
);

-- Повторный опрос того же письма не должен плодить файлы.
CREATE UNIQUE INDEX IF NOT EXISTS mail_attachments_uniq
  ON mail_attachments (account_id, message_id, filename, size_bytes);

CREATE INDEX IF NOT EXISTS mail_attachments_message
  ON mail_attachments (account_id, message_id);

CREATE INDEX IF NOT EXISTS mail_attachments_lead
  ON mail_attachments (lead_id, created_at DESC);
