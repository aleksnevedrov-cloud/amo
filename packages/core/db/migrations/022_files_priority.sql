-- RFD-AI-AGENT-FILES-PRIORITY: приоритет разбора файлов — новые (за 24 часа) / догрузка старых / отложенные по лимиту.
-- documents.priority — к какой группе отнесён разбор (расход дневного лимита по группам); вложения писем, не разобранные из-за
-- дневного лимита прежним кодом, переводятся в «отложено» и разбираются автоматически. Только добавление и перевод статуса.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'new';
CREATE INDEX IF NOT EXISTS documents_account_day_priority ON documents (account_id, created_at, priority);
UPDATE mail_attachments SET extract_status = 'deferred' WHERE extract_status = 'error' AND extract_error ILIKE '%дневной лимит%';
CREATE INDEX IF NOT EXISTS mail_attachments_deferred ON mail_attachments (account_id, created_at) WHERE extract_status = 'deferred';
