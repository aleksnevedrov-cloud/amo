-- RFD-AI-AGENT-OPT-KP-NAME: текст колонок прайса «Покрытие» и «Комплектация» у записи цены — для наименования строки КП
-- («… — по прайсу: ДВ CPL 0,2 мм») и строки комплектации под позицией.
ALTER TABLE kb_prices
  ADD COLUMN IF NOT EXISTS coating text,
  ADD COLUMN IF NOT EXISTS equipment text;
