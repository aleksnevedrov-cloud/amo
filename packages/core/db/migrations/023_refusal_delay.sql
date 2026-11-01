-- RFD-AI-AGENT-REFUSAL-ANALYSIS, исправление: анализ отказа запускается с задержкой после перехода (запись звонка приходит
-- в amo позже) и откладывается, пока у звонка нет записи; факты общения без текста (короткие звонки, чаты без текста).
ALTER TABLE refusal_analyses ADD COLUMN IF NOT EXISTS next_try_at timestamptz;
ALTER TABLE refusal_analyses ADD COLUMN IF NOT EXISTS facts jsonb;
CREATE INDEX IF NOT EXISTS refusal_analyses_due ON refusal_analyses (account_id, next_try_at) WHERE note_id IS NULL;
