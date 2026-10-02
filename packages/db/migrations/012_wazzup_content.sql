-- Вложения клиента из вебхуков Wazzup (Salesbot их не передаёт): ссылка, тип, отметка «использовано агентом».
ALTER TABLE wazzup_messages
  ADD COLUMN IF NOT EXISTS content_uri text,
  ADD COLUMN IF NOT EXISTS content_type text,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
CREATE INDEX IF NOT EXISTS wazzup_messages_content_idx
  ON wazzup_messages (account_id, phone, sent_at)
  WHERE content_uri IS NOT NULL AND direction = 'in';
