-- RFD-AI-AGENT-FIX-PACK-2410, ч. 2: несколько почтовых ящиков. Пароль и позиция чтения — на ящик (mailbox_id; прежний ящик —
-- main). Прежний ящик из полей email переносится первым элементом email.mailboxes с mode reply (дочитка 0 дней — он уже читался).
ALTER TABLE mailbox_credentials ADD COLUMN IF NOT EXISTS mailbox_id text NOT NULL DEFAULT 'main';
ALTER TABLE mailbox_credentials DROP CONSTRAINT IF EXISTS mailbox_credentials_pkey;
ALTER TABLE mailbox_credentials ADD PRIMARY KEY (account_id, mailbox_id);

ALTER TABLE mailbox_state ADD COLUMN IF NOT EXISTS mailbox_id text NOT NULL DEFAULT 'main';
ALTER TABLE mailbox_state DROP CONSTRAINT IF EXISTS mailbox_state_pkey;
ALTER TABLE mailbox_state ADD PRIMARY KEY (account_id, mailbox_id, folder);

UPDATE widget_settings
   SET settings = jsonb_set(settings, '{email,mailboxes}', jsonb_build_array(jsonb_build_object(
         'id', 'main',
         'address', COALESCE(NULLIF(settings->'email'->>'fromAddress', ''), settings->'email'->>'username'),
         'imapHost', settings->'email'->>'imapHost',
         'imapPort', COALESCE((settings->'email'->>'imapPort')::int, 993),
         'imapSecure', COALESCE((settings->'email'->>'imapSecure')::boolean, true),
         'username', settings->'email'->>'username',
         'inboxFolder', COALESCE(NULLIF(settings->'email'->>'inboxFolder', ''), 'INBOX'),
         'sentFolder', COALESCE(settings->'email'->>'sentFolder', ''),
         'mode', 'reply',
         'backfillDays', 0)), true)
 WHERE settings ? 'email'
   AND COALESCE(settings->'email'->>'imapHost', '') <> ''
   AND COALESCE(settings->'email'->>'username', '') <> ''
   AND (NOT (settings->'email' ? 'mailboxes') OR jsonb_array_length(settings->'email'->'mailboxes') = 0);
