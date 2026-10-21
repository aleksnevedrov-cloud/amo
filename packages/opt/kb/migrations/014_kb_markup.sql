-- KB-MARKUP: наценка в % у прайса-источника («Оникс +20 %»). Цены kb_prices остаются ценами фабрики; наценка применяется
-- при расчёте КП: цена × (1 + markup_pct / 100), с округлением до рубля. Только добавление колонки: у всех существующих
-- источников значение по умолчанию 0 — расчёты не меняются; строки не переписываются (UPDATE нет).
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS markup_pct numeric NOT NULL DEFAULT 0 CHECK (markup_pct >= -50 AND markup_pct <= 300);
