-- RFD-AI-AGENT-OPT-PRICE, этап 5: версия черновика для защиты от гонки при автозаполнении цен
-- (задание поиска пишет только свою позицию и проверяет, что черновик не менялся).
ALTER TABLE kp_drafts ADD COLUMN version int NOT NULL DEFAULT 0;
