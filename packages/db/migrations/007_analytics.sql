-- Фаза 4: исходы диалогов для аналитики (конверсия = сделка ушла вперёд по воронке после общения с AI).
CREATE TABLE dialog_outcomes (
  account_id        bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id           bigint NOT NULL,
  pipeline_id       bigint,
  first_status_id   bigint,
  first_ai_at       timestamptz NOT NULL DEFAULT now(),
  last_status_id    bigint,
  last_pipeline_id  bigint,
  advanced          boolean NOT NULL DEFAULT false,   -- этап дальше начального
  won               boolean NOT NULL DEFAULT false,   -- 142 «Успешно реализовано»
  lost              boolean NOT NULL DEFAULT false,   -- 143 «Закрыто и не реализовано»
  checked_at        timestamptz,
  PRIMARY KEY (account_id, lead_id)
);
CREATE INDEX dialog_outcomes_check_idx ON dialog_outcomes (account_id, checked_at) WHERE NOT won AND NOT lost;
