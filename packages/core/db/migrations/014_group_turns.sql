-- История переписки агента в групповых чатах Wazzup (RFD-AI-AGENT-GRUPPOVYE-CHATY):
-- у группы нет сделки, поэтому нить диалога хранится по chat_id.
CREATE TABLE IF NOT EXISTS group_turns (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  chat_type text,
  role text NOT NULL CHECK (role IN ('client', 'assistant')),
  author text,
  text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_turns_chat_idx ON group_turns (account_id, chat_id, created_at DESC);
