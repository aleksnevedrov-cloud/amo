-- OAuth интеграции «РФ-Мессенджер» в amoCRM: доступ к REST API аккаунта (привязка чата к контакту,
-- телефоны контакта, amojo_id сотрудника) для кнопки «Написать первым». Токены зашифрованы (AES-256-GCM).
CREATE TABLE amo_oauth (
  account_id     bigint PRIMARY KEY,
  base_domain    text NOT NULL,
  access_token   text NOT NULL,
  refresh_token  text NOT NULL,
  expires_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
