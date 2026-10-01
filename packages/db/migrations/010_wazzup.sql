-- Wazzup: переписка менеджеров с клиентами в WhatsApp/Telegram (вебхуки API v3 + разовый импорт messages_dump).
-- Агент читает историю по телефону контакта сделки (RFD-AI-AGENT-WAZZUP-HISTORY).
CREATE TABLE wazzup_messages (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id  text NOT NULL,
  channel_id  text,
  chat_id     text NOT NULL,
  chat_type   text,
  phone       text,
  direction   text NOT NULL CHECK (direction IN ('in','out')),
  author      text NOT NULL DEFAULT 'unknown',
  text        text NOT NULL DEFAULT '',
  status      text,
  is_system   boolean NOT NULL DEFAULT false,
  contact_id  bigint,
  lead_id     bigint,
  sent_at     timestamptz NOT NULL,
  source      text NOT NULL DEFAULT 'webhook',
  raw         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, message_id)
);
CREATE INDEX wazzup_messages_phone_idx ON wazzup_messages (account_id, phone, sent_at DESC);
CREATE INDEX wazzup_messages_chat_idx ON wazzup_messages (account_id, chat_id, sent_at DESC);

CREATE TABLE wazzup_state (
  account_id     bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  webhook_uri    text,
  subscribed_at  timestamptz,
  last_event_at  timestamptz,
  events_total   bigint NOT NULL DEFAULT 0,
  last_error     text,
  last_error_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
