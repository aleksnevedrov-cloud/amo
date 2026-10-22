-- RFD-AI-AGENT-OPT-CALLS, этапы 2–3: расшифровка, анализ, примечание в amo. Только добавление колонок.
-- attempts — сколько раз шаг (transcribe / analyze / post) падал; после 3 — алерт и остановка.
ALTER TABLE calls ADD COLUMN attempts int NOT NULL DEFAULT 0;
-- Режим SpeechKit: async — новые звонки из опроса; deferred — догрузка старых записей (дешевле, до суток).
ALTER TABLE calls ADD COLUMN stt_mode text NOT NULL DEFAULT 'async';
ALTER TABLE calls ADD COLUMN alerted_at timestamptz;
CREATE INDEX calls_processing ON calls (account_id, status, updated_at) WHERE status IN ('downloaded', 'transcribed', 'analyzed', 'failed');
