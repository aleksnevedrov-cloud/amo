-- RFD-AI-AGENT-OPT-KB, этап 3: одна запись цены на аккаунт + модель + размер + происхождение + источник (повтор обновляет).
CREATE UNIQUE INDEX kb_prices_key ON kb_prices (account_id, model_key, coalesce(base_size, ''), origin, coalesce(source_id, 0));
