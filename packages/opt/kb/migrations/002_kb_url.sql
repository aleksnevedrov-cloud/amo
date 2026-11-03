-- RFD-AI-AGENT-OPT-KB, этап 2: источники-ссылки — обход раздела, родитель, код ответа, хэш содержимого
-- (при плановой переиндексации неизменённая страница не пересчитывает эмбеддинги).
ALTER TABLE kb_sources
  ADD COLUMN crawl        boolean NOT NULL DEFAULT false,
  ADD COLUMN parent_id    bigint REFERENCES kb_sources(id) ON DELETE SET NULL,
  ADD COLUMN http_status  integer,
  ADD COLUMN content_hash text;
CREATE INDEX kb_sources_parent ON kb_sources (parent_id) WHERE parent_id IS NOT NULL;
-- Одна ссылка на аккаунт: повторное добавление того же адреса — переиндексация существующего источника.
CREATE UNIQUE INDEX kb_sources_url ON kb_sources (account_id, original) WHERE kind = 'url';
