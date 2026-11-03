-- RFD-AI-AGENT-OPT-KB, этап 3: веб-поиск группируется по модели — ключ модели без размера для кэша
-- (один поиск на модель, размеры пересчитываются по площади); кэш — 30 дней.
ALTER TABLE kp_price_research ADD COLUMN model_key text NOT NULL DEFAULT '';
CREATE INDEX kp_price_research_model ON kp_price_research (account_id, model_key, created_at DESC);
