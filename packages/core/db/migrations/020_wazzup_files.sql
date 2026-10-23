-- RFD-AI-AGENT-WA-FILES: разбор файлов Wazzup в обе стороны (документы и картинки клиента и менеджера, в т. ч. КП).
-- Извлечённый текст хранится один раз на сообщение; file_status: null — не разбирали, done / skipped (аудио, видео,
-- неподдерживаемый формат) / failed (ошибка скачивания или разбора, error). Только добавление колонок.
ALTER TABLE wazzup_messages
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS file_text text,
  ADD COLUMN IF NOT EXISTS file_status text,
  ADD COLUMN IF NOT EXISTS file_error text,
  ADD COLUMN IF NOT EXISTS file_extracted_at timestamptz;
CREATE INDEX IF NOT EXISTS wazzup_messages_file_pending
  ON wazzup_messages (account_id, sent_at)
  WHERE content_uri IS NOT NULL AND file_status IS NULL;
