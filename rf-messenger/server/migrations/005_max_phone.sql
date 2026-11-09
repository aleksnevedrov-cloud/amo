-- Канал «MAX по номеру телефона» через GREEN-API (вид max_phone). Существующий вид max (бот) без изменений.
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('telegram_bot', 'whatsapp', 'telegram_user', 'max', 'vk', 'avito', 'max_phone'));
