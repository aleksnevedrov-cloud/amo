-- Раздел «Rf Messenger» в левом меню: статус «неотвеченное» по чату (как у Wazzup).
-- unanswered — красный счётчик: входящие без ответа; answered — серый: сколько закрыто последним ответом
-- или кнопкой «Отвечать не нужно» (обнуляется следующим входящим). Открытие чата ничего не меняет.
ALTER TABLE chats ADD COLUMN unanswered integer NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN answered integer NOT NULL DEFAULT 0;
-- Чем закрыто: reply — ответом (из раздела, карточки или чата amoCRM), button — кнопкой «Отвечать не нужно».
ALTER TABLE chats ADD COLUMN closed_by text CHECK (closed_by IN ('reply', 'button'));
ALTER TABLE chats ADD COLUMN closed_by_user_id bigint;
ALTER TABLE chats ADD COLUMN closed_message_id bigint;
ALTER TABLE chats ADD COLUMN closed_at timestamptz;
ALTER TABLE chats ADD COLUMN pinned boolean NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN last_inbound_at timestamptz;
CREATE INDEX chats_inbox ON chats (account_id, pinned DESC, last_message_at DESC);
