-- Сотрудник amoCRM (id пользователя в API чатов), от имени которого в amo показываются сообщения,
-- отправленные с телефона менеджера. Берётся из вебхука amo об исходящем сообщении (message.sender.id):
-- по чату — последний писавший в этот чат, по аккаунту — последний писавший в любой чат.
ALTER TABLE chats ADD COLUMN amo_operator_ref text;
ALTER TABLE amojo_connections ADD COLUMN amo_operator_ref text;
