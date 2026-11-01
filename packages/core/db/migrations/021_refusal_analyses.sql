-- RFD-AI-AGENT-REFUSAL-ANALYSIS: анализ сделки при переносе в «Отказ» — одна строка на один переход (событие
-- lead_status_changed amoCRM), защита от дублей по event_id; результат модели, примечание и задача администратора.
-- Только добавление.
CREATE TABLE IF NOT EXISTS refusal_analyses (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL,
  lead_id       bigint NOT NULL,
  event_id      text NOT NULL,
  changed_at    timestamptz NOT NULL,
  status_id     integer NOT NULL,
  pipeline_id   integer NOT NULL,
  analysis      jsonb,
  counts        jsonb,
  item_ids      jsonb NOT NULL DEFAULT '[]'::jsonb,
  note_id       bigint,
  note_text     text,
  task_id       bigint,
  task_updated  boolean NOT NULL DEFAULT false,
  provider      text,
  model         text,
  cost          jsonb,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS refusal_analyses_lead ON refusal_analyses (account_id, lead_id, created_at);
