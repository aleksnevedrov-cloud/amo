-- RFD-AI-AGENT-REAKTIVATSIYA: агент сам догоняет клиента после отказа — два касания за неделю, затем молчит навсегда.
-- Одна строка на одну отказную сделку; переход берётся из refusal_analyses (event_id), повторный отказ строку не плодит.
-- Только добавление.
CREATE TABLE IF NOT EXISTS reactivation_leads (
  id              bigserial PRIMARY KEY,
  account_id      bigint NOT NULL,
  lead_id         bigint NOT NULL,
  -- Переход в «Отказ», с которого начали: тот же event_id, что в refusal_analyses.
  event_id        text NOT NULL,
  refused_at      timestamptz NOT NULL,
  -- Бюджет сделки на момент отбора, ₽ (порог reactivation.minBudget).
  budget          bigint NOT NULL DEFAULT 0,
  -- Причина отказа: свободный текст модели и набор текстов, выбранный по ключевым словам.
  reason          text,
  reason_code     text NOT NULL DEFAULT 'universal',
  -- planned → касание запланировано; touched → отправлено, ждём ответа; дальше — исход.
  -- interested (интерес), postponed (назвал срок), reminder (подумаю без срока, напомним сам),
  -- stopped (молчит после второго касания или стоп по правилу), done (ответил отказом, шаблон отправлен).
  state           text NOT NULL DEFAULT 'planned',
  stop_reason     text,
  touches         smallint NOT NULL DEFAULT 0,
  last_touch_at   timestamptz,
  next_touch_at   timestamptz,
  client_reply_at timestamptz,
  -- Шаблон «Отказ» (опрос отдела качества) отправлен последним сообщением.
  final_sent      boolean NOT NULL DEFAULT false,
  -- Задача менеджеру при интересе/названном сроке и перевод сделки на этап «Заказ».
  task_id         bigint,
  moved_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Одна сделка — одна строка: повторный переход в отказ не начинает догон заново.
CREATE UNIQUE INDEX IF NOT EXISTS reactivation_leads_lead ON reactivation_leads (account_id, lead_id);
-- Очередь касаний.
CREATE INDEX IF NOT EXISTS reactivation_leads_due ON reactivation_leads (account_id, next_touch_at)
  WHERE next_touch_at IS NOT NULL;
