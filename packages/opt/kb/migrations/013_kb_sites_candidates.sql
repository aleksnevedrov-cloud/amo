-- KP-AGENT-V2, п. 4а: у сайта-источника (kb_sources.kind = 'url') — комментарий менеджера «какие двери есть на сайте»
-- (до 2000 знаков) и флаг «фабрика»: по ним агент выбирает, где сначала искать цену позиции.
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS comment text CHECK (comment IS NULL OR length(comment) <= 2000);
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS is_factory boolean NOT NULL DEFAULT false;

-- П. 4.4: цена, подтверждённая менеджером в КП (выбранная из интернета или введённая), — «кандидат в прайс». В подбор
-- следующих КП не попадает; вкладка в виджете и выгрузка xlsx — для переноса в Excel-прайс заказчика.
CREATE TABLE IF NOT EXISTS kb_price_candidates (
  id           bigserial PRIMARY KEY,
  account_id   bigint NOT NULL,
  lead_id      bigint,
  draft_id     bigint,
  model        text NOT NULL,
  size         text,
  price        numeric(14, 2) NOT NULL CHECK (price > 0),
  -- web_confirmed — выбрана из цен интернета; manager — введена менеджером.
  source       text NOT NULL CHECK (source IN ('web_confirmed', 'manager')),
  url          text,
  note         text,
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Одна позиция одного черновика — одна запись (повторное подтверждение обновляет цену).
CREATE UNIQUE INDEX IF NOT EXISTS kb_price_candidates_key ON kb_price_candidates (account_id, coalesce(draft_id, 0), model, coalesce(size, ''));
CREATE INDEX IF NOT EXISTS kb_price_candidates_account ON kb_price_candidates (account_id, created_at DESC);
