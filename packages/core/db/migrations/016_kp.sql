-- Настройки КП и черновики предложений (тема RFD-AI-AGENT-KP, этап 3).
CREATE TABLE IF NOT EXISTS kp_settings (
  account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  template_path text,
  template_name text,
  template_md5 text,
  template_updated_at timestamptz,
  constants jsonb NOT NULL DEFAULT '{}'::jsonb,
  certs_dir text,
  numbering jsonb NOT NULL DEFAULT '{"prefix": "КП", "year": null, "counter": 0}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kp_drafts (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id bigint NOT NULL,
  -- draft → built → sent, либо cancelled
  status text NOT NULL DEFAULT 'draft',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  docx_path text,
  pdf_path text,
  kp_no text,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  built_at timestamptz,
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS kp_drafts_lead
  ON kp_drafts (account_id, lead_id, created_at DESC);

-- Номер выдаётся при первой удачной сборке и больше не меняется.
CREATE UNIQUE INDEX IF NOT EXISTS kp_drafts_no
  ON kp_drafts (account_id, kp_no) WHERE kp_no IS NOT NULL;
