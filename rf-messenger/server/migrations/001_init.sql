-- RFD-MESSENGER, этап 1: подключение к API чатов amo, каналы, чаты, сообщения, файлы.
-- account_id — id аккаунта amoCRM из проверенного токена виджета.

CREATE TABLE amojo_connections (
  account_id        bigint PRIMARY KEY,
  amojo_account_id  uuid NOT NULL,
  scope_id          text NOT NULL UNIQUE,
  connected_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id             bigserial PRIMARY KEY,
  account_id     bigint NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('telegram_bot', 'whatsapp', 'telegram_user', 'max', 'vk', 'avito')),
  title          text NOT NULL,
  -- Логин канала для показа и защиты от двойного подключения: @username бота, номер телефона.
  external_id    text NOT NULL,
  status         text NOT NULL DEFAULT 'starting'
                 CHECK (status IN ('starting', 'connected', 'no_phone', 'session_ended', 'error')),
  status_detail  text,
  -- Зашифрованы SecretBox: токены и ключи, сессия (WhatsApp/Telegram).
  credentials    text NOT NULL,
  session        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX channels_unique_active ON channels (account_id, kind, external_id) WHERE deleted_at IS NULL;

CREATE TABLE chats (
  id                bigserial PRIMARY KEY,
  account_id        bigint NOT NULL,
  channel_id        bigint NOT NULL REFERENCES channels (id),
  external_chat_id  text NOT NULL,
  -- Наш id беседы для amo (conversation_id).
  conversation_id   text NOT NULL UNIQUE,
  is_group          boolean NOT NULL DEFAULT false,
  title             text NOT NULL,
  contact           jsonb NOT NULL DEFAULT '{}',
  amojo_chat_id     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_message_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_chat_id)
);
CREATE INDEX chats_account ON chats (account_id, last_message_at DESC);

CREATE TABLE files (
  id            uuid PRIMARY KEY,
  account_id    bigint NOT NULL,
  channel_id    bigint REFERENCES channels (id),
  name          text NOT NULL,
  mime          text NOT NULL,
  size          bigint NOT NULL,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                   bigserial PRIMARY KEY,
  account_id           bigint NOT NULL,
  chat_id              bigint NOT NULL REFERENCES chats (id),
  -- in — от клиента; out — клиенту (source: amo — из amoCRM, phone — с телефона менеджера).
  direction            text NOT NULL CHECK (direction IN ('in', 'out')),
  source               text NOT NULL CHECK (source IN ('client', 'amo', 'phone')),
  kind                 text NOT NULL CHECK (kind IN ('text', 'picture', 'file', 'video', 'voice', 'audio', 'sticker')),
  text                 text NOT NULL DEFAULT '',
  file_id              uuid REFERENCES files (id),
  -- Вложение из amo до скачивания: ссылка, имя, размер.
  media                jsonb,
  -- Автор в групповом чате.
  author               jsonb,
  reply_to_message_id  bigint REFERENCES messages (id),
  external_id          text,
  amojo_msgid          text,
  status               text NOT NULL CHECK (status IN ('received', 'synced', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_external ON messages (chat_id, direction, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX messages_amojo ON messages (account_id, amojo_msgid) WHERE amojo_msgid IS NOT NULL;
CREATE INDEX messages_chat ON messages (chat_id, id);
