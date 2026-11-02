-- RFD-AI-AGENT-OPT-CALLS, этап 1: записи разговоров менеджеров из примечаний amoCRM (call_in / call_out).
-- Только БД опта (ai_door_opt); розницу не касается. Только добавление: таблицы новые.
CREATE TABLE calls (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Примечание amo, из которого взят звонок: где лежит (contact / lead) и его id. Один звонок — одно примечание.
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
  -- Время звонка — created_at примечания; updated_at примечания — для отметки сбора.
  called_at timestamptz NOT NULL,
  note_updated_at timestamptz NOT NULL,
  -- Менеджер: responsible_user_id примечания, иначе created_by.
  manager_id bigint,
  -- Сделка, к которой привязан звонок: примечание сделки — она сама; примечание контакта — открытая сделка контакта
  -- в воронках из настроек (самая свежая по updated_at); null — не нашли.
  lead_id bigint,
  -- new → downloaded → transcribed → analyzed → posted; unavailable — запись не отдаётся; failed — ошибка на шаге stage.
  status text NOT NULL DEFAULT 'new',
  stage text,
  error text,
  -- MP3 на томе относительно KP_FILES_ROOT («calls/<аккаунт>/<год-месяц>/<id>_<ключ>.mp3»); null — ещё не скачан или удалён по сроку.
  file_path text,
  file_bytes int,
  file_mime text,
  downloaded_at timestamptz,
  file_deleted_at timestamptz,
  -- Этапы 2–3: расшифровка по ролям, разбор модели, что ушло в amo, затраты.
  transcript jsonb,
  analysis jsonb,
  posted jsonb,
  cost jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX calls_note ON calls (account_id, note_id, record_key);
CREATE INDEX calls_status ON calls (account_id, status, called_at DESC);
CREATE INDEX calls_lead ON calls (account_id, lead_id, called_at DESC);
CREATE INDEX calls_called ON calls (account_id, called_at DESC);
CREATE INDEX calls_file_age ON calls (account_id, downloaded_at) WHERE file_path IS NOT NULL;

-- Отметка сбора по аккаунту и типу примечаний: с какого updated_at запрашивать в следующий раз.
CREATE TABLE calls_sync (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity text NOT NULL,
  last_updated_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_error text,
  PRIMARY KEY (account_id, entity)
);
