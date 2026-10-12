-- База знаний «Агента опт» (ТЗ разделение, раздел 9): пять справочников, по одному файлу на вид и аккаунт.
-- usage: reference — справочные данные для менеджера и расчёта; block — готовый текст (на старте не используется).
CREATE TABLE kp_knowledge_items (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('delivery', 'installation', 'b2b', 'analogs', 'stoplist')),
  usage       text NOT NULL DEFAULT 'reference' CHECK (usage IN ('reference', 'block')),
  filename    text NOT NULL,
  -- Исходный файл как загружен: его можно скачать и поправить.
  content     text NOT NULL,
  -- Разобранные и проверенные строки (или разделы регламента).
  data        jsonb NOT NULL,
  rows        integer NOT NULL DEFAULT 0,
  updated_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind)
);
