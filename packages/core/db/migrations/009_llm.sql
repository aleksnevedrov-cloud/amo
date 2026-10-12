-- 1.1.0: переключение провайдера LLM (Anthropic ↔ OpenAI).

-- Провайдер и модель, заданные для отдельной сделки в панели карточки (иерархия: сделка > этап > воронка > глобально).
ALTER TABLE conversations ADD COLUMN llm_provider text, ADD COLUMN llm_model text;

-- Кэш списка моделей провайдера по аккаунту (24 ч + кнопка «Обновить список»).
CREATE TABLE llm_models_cache (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  models      jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider)
);

-- Прогоны eval-набора на выбранных моделях из «Песочницы».
CREATE TABLE eval_runs (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  models      jsonb NOT NULL,
  dialog_ids  jsonb NOT NULL DEFAULT '[]',
  results     jsonb NOT NULL DEFAULT '[]',
  summary     jsonb,
  error       text,
  started_by  bigint,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX eval_runs_account_idx ON eval_runs (account_id, id DESC);

-- Аналитика по провайдеру и модели: в details ответов хранятся provider и model.
CREATE INDEX ai_journal_model_idx ON ai_journal (account_id, (details->>'provider'), (details->>'model'));
