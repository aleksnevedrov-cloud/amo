-- Общий код разбора файлов (packages/core/docs, RFD-AI-AGENT-FILES-PRIORITY) пишет и читает documents.priority —
-- колонка появилась в БД розницы миграцией 022; в БД опта (ai_door_opt) — эта. Только добавление.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'new';
CREATE INDEX IF NOT EXISTS documents_account_day_priority ON documents (account_id, created_at, priority);
