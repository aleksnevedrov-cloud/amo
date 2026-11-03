-- Выгрузки истории сообщений Wazzup (messages_dump): заявка, статус у Wazzup, итог импорта в wazzup_messages.
CREATE TABLE IF NOT EXISTS wazzup_dumps (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  export_id text,
  channel_id text,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  url text,
  columns text,
  rows_total integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  error text,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS wazzup_dumps_account_idx ON wazzup_dumps (account_id, id DESC);
