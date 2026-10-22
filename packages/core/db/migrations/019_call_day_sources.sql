-- RFD-AI-AGENT-CALLS-DAY-FULL: итог дня по всему общению — id записей ленты (звонки, сообщения, письма, примечания) и
-- счётчики по видам; повторный запуск в тот же день берёт только новое общение. Только добавление колонок.
ALTER TABLE call_day_summaries ADD COLUMN IF NOT EXISTS item_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE call_day_summaries ADD COLUMN IF NOT EXISTS counts jsonb;
