-- Почта: отдельное подключение к ящику (IMAP + SMTP).

-- Пароль ящика — только в зашифрованном виде (AES-256-GCM), в API не возвращается.
CREATE TABLE mailbox_credentials (
  account_id    bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_enc  text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint
);

-- Позиция чтения папок: обрабатываются только письма с UID больше last_uid.
CREATE TABLE mailbox_state (
  account_id    bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder        text NOT NULL,
  uid_validity  text NOT NULL,
  last_uid      bigint NOT NULL,
  last_ok_at    timestamptz,
  last_error    text,
  last_error_at timestamptz,
  PRIMARY KEY (account_id, folder)
);

-- Письма, отправленные AI: защита от петель и распознавание своих писем в «Отправленных».
CREATE TABLE email_outbound (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id     bigint NOT NULL,
  to_address  text NOT NULL,
  message_id  text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbound_to_idx ON email_outbound (account_id, lower(to_address), sent_at DESC);
CREATE UNIQUE INDEX email_outbound_msgid_idx ON email_outbound (account_id, message_id);

-- Последнее письмо менеджера клиенту (из «Отправленных») — AI встаёт на паузу.
CREATE TABLE email_manager_activity (
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address     text NOT NULL,
  last_at     timestamptz NOT NULL,
  PRIMARY KEY (account_id, address)
);

-- Канал входящего сообщения и данные письма (Message-ID, тема, адрес) для ответа в цепочку.
ALTER TABLE pending_messages ADD COLUMN channel text NOT NULL DEFAULT 'chat', ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
