-- RFD-AI-AGENT-CALLS-RETAIL: записи разговоров из примечаний amoCRM (call_in / call_out) и итоги разговоров за день.
-- Перенос из опта (ветка claude/opt-kb, миграции 006 и 007) с заменой примечания по звонку на итог дня.
CREATE TABLE IF NOT EXISTS calls (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Примечание amo, из которого взят звонок: где лежит (contact / lead) и его id.
  note_id bigint NOT NULL,
  entity text NOT NULL,
  entity_id bigint NOT NULL,
  -- Ключ записи из ссылки (uuid ВАТС МегаФон); у ссылок без uuid — имя файла. Вместе с note_id — ключ дедупликации.
  record_key text NOT NULL,
  direction text NOT NULL,
  phone text NOT NULL DEFAULT '',
  duration_sec int NOT NULL DEFAULT 0,
  call_status int,
  link text NOT NULL,
  called_at timestamptz NOT NULL,
  note_updated_at timestamptz NOT NULL,
  manager_id bigint,
  -- Сделка: примечание сделки — она сама; примечание контакта — открытая сделка контакта в воронке «Двери» (самая свежая).
  lead_id bigint,
  -- new → downloaded → transcribed → posted (вошёл в итог дня с примечанием) / analyzed (в итоге без примечания или вне воронки);
  -- unavailable — запись не отдаётся; failed — ошибка на шаге stage (download / transcribe / day), attempts — попытки.
  status text NOT NULL DEFAULT 'new',
  stage text,
  error text,
  attempts int NOT NULL DEFAULT 0,
  -- Режим SpeechKit: async — новые звонки из опроса; deferred — догрузка старых записей.
  stt_mode text NOT NULL DEFAULT 'async',
  alerted_at timestamptz,
  file_path text,
  file_bytes int,
  file_mime text,
  downloaded_at timestamptz,
  file_deleted_at timestamptz,
  transcript jsonb,
  cost jsonb,
  -- Итог дня, в который вошёл звонок.
  day_summary_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calls_note ON calls (account_id, note_id, record_key);
CREATE INDEX IF NOT EXISTS calls_status ON calls (account_id, status, called_at DESC);
CREATE INDEX IF NOT EXISTS calls_lead ON calls (account_id, lead_id, called_at DESC);
CREATE INDEX IF NOT EXISTS calls_file_age ON calls (account_id, downloaded_at) WHERE file_path IS NOT NULL;

-- Отметка сбора по аккаунту и типу примечаний (contact / lead) и отметка запуска итога дня (day_summary).
CREATE TABLE IF NOT EXISTS calls_sync (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity text NOT NULL,
  last_updated_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_error text,
  PRIMARY KEY (account_id, entity)
);

-- Итог разговоров за день по сделке (lead_id) или контакту (contact_id): разбор модели, примечание в amo, звонки.
CREATE TABLE IF NOT EXISTS call_day_summaries (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id bigint,
  contact_id bigint,
  day date NOT NULL,
  -- business — были деловые звонки (примечание пишется); false — все без делового содержания.
  business boolean NOT NULL DEFAULT true,
  summary jsonb NOT NULL,
  call_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  calls_count int NOT NULL DEFAULT 0,
  total_duration_sec int NOT NULL DEFAULT 0,
  note_id bigint,
  note_entity text,
  note_text text,
  provider text,
  model text,
  cost jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_day_summaries_lead ON call_day_summaries (account_id, lead_id, day DESC);
CREATE INDEX IF NOT EXISTS call_day_summaries_contact ON call_day_summaries (account_id, contact_id, day DESC);
