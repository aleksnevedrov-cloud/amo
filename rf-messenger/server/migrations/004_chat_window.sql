-- Окно переписки в карточке сделки: прочитанность чатов, имя менеджера у исходящих, история,
-- шаблоны сообщений (общие и личные).

ALTER TABLE chats ADD COLUMN read_at timestamptz;

-- Исходящие из окна: кто отправил (имя и id сотрудника amoCRM). Из вебхука amo — имя отправителя.
ALTER TABLE messages ADD COLUMN sender_name text;
ALTER TABLE messages ADD COLUMN sender_user_id bigint;
-- Загруженная история переписки: видна в окне, в ленту amoCRM не передаётся.
ALTER TABLE messages ADD COLUMN from_history boolean NOT NULL DEFAULT false;
CREATE INDEX messages_chat_created ON messages (chat_id, created_at DESC, id DESC);

CREATE TABLE templates (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL,
  -- NULL — общий шаблон аккаунта (правит администратор); иначе личный шаблон сотрудника.
  owner_user_id  bigint,
  title          text NOT NULL,
  text           text NOT NULL,
  folder         text NOT NULL DEFAULT '',
  -- [{fileId, name, mime, size}] — фото и PDF из нашего хранилища файлов.
  attachments    jsonb NOT NULL DEFAULT '[]',
  use_count      integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_account ON templates (account_id, owner_user_id, use_count DESC);
