# RFD-AI-AGENT-OPT-KB, этап 1: хранилище, индексация текстов и файлов, вкладка «База знаний»

Дата: 15.10.2026. Ветка: `claude/opt-kb` (от `claude/new-session-8uzdox`, коммит 56015db). Коммит этапа — в истории ветки (первый коммит после 56015db).

Розница и ядро не менялись: `git diff -- packages/retail apps/api apps/worker apps/widget packages/core` = 0 строк.

## Что сделано

| Часть | Где | Содержание |
| --- | --- | --- |
| Контейнер | `docker-compose.opt.yml` | сервис `opt-kb-db` (`pgvector/pgvector:pg16`), БД `ai_door_opt_kb` / пользователь `aidoor_opt_kb`, том `opt-kb-data`, healthcheck `pg_isready`, портов наружу нет; тома `opt-kb-files` → `/kb-files` в opt-api и opt-worker; opt-api ждёт здоровья `opt-kb-db` |
| Переменные | `.env.opt.example`, `scripts/opt/preflight.sh` | `KB_DB_PASSWORD`, `KB_DATABASE_URL`, необязательная `KB_EMBEDDING_MODEL`; preflight проверяет, что заданы и пароль совпадает |
| Образ | `Dockerfile.opt` | манифест `packages/opt/kb`, миграции → `/app/kb-migrations`, `KB_MIGRATIONS_DIR`, `KB_FILES_ROOT=/kb-files`, каталог `/kb-files` для `node` |
| Пакет | `packages/opt/kb` (`@opt/kb`) | `env.ts` — свой zod-загрузчик (ядро не трогаем); `migrations/001_kb_init.sql` — `kb_sources`, `kb_chunks` (vector(1536), tsvector, индексы hnsw/gin/trgm), `kb_prices`, `kb_aliases`; `chunk.ts` — фрагменты ≤ 1 500 символов с метаданными (страница, лист, заголовок), строки таблиц не режутся; `extract.ts` — pdf/docx/xlsx/csv/txt/md и сканы через OCR аккаунта, лимиты под прайсы (50 МБ, 50 000 строк, 2 млн символов); `embeddings.ts` — OpenAI `text-embedding-3-small` тем же SDK и ключом, что чат-модель опта (ключ аккаунта → серверный), цена $0,02/1M; `repo.ts` — источники, фрагменты, лимиты 500 МБ / 20 000 фрагментов, векторный, полнотекстовый (russian) и триграммный поиск; `search.ts` — гибридный поиск RRF (вектор + текст), подпись источника; `core.ts` — добавление текста/файла (копия на томе), индексация, переиндексация, удаление, поиск, журнал |
| Ядро опта | `packages/opt/kp/src/deps.ts` | `OptCore.kb: KbCore`: пул `KB_DATABASE_URL`, эмбеддер по ключу OpenAI аккаунта, OCR по настройке «Разбор файлов», курс для журнала; в тестах подменяются `kbDb`, `kbFilesRoot`, `embedderFor` |
| API | `apps/opt-api/src/routes/kb.ts`, `deps.ts`, `health.ts`, `server.ts` | `GET /widget/v1/kb/sources` (список + занято), `POST …/sources/text`, `POST …/sources/file` (base64 в JSON, лимит тела 72 МБ), `POST …/sources/:id/reindex`, `DELETE …/sources/:id`, `GET …/sources/:id/chunks`, `GET …/search?q=` (top-5); добавление/удаление — только админ; очередь `kb-index` (BullMQ, Redis база 1, одно задание на источник); `/health` → `kb_db`; миграции базы знаний при старте |
| Воркер | `apps/opt-worker/src/main.ts` | обработчик очереди `kb-index` (concurrency 1), лог «opt-worker запущен: очереди kp, kp-research и kb-index» |
| Виджет | `apps/opt-widget` 1.0.9 → 1.1.0 | вкладка «База знаний»: файл (pdf, docx, xlsx, csv, txt, md, jpg/png), текст менеджера, строка «Проверить поиск», список источников (тип, объём, фрагменты, даты, статус «в очереди / индексируется / проиндексирован / ошибка» с текстом ошибки), действия «Фрагменты», «Переиндексировать», «Удалить» (с подтверждением); опрос списка раз в 3 с, пока есть источники в очереди; журнал — фильтры `kb_index`, `kb_search` |
| Журнал | общий журнал опта (`ai_journal` в `ai_door_opt`) | `kb_index` — фрагменты, эмбеддинги, токены, стоимость; `kb_search` — запрос, найденные фрагменты, стоимость эмбеддинга запроса; `note` — добавлен/удалён источник (audit `kb`) |

Отклонения от таблицы ТЗ (раздел 2) — дополнительные поля, без изменения смысла: `kb_sources.file_path` (копия на томе для переиндексации), `kb_sources.embedded_chunks` (сколько фрагментов с эмбеддингом — 0, когда ключа OpenAI нет), `kb_chunks.tsv` (полнотекстовый индекс). Без ключа OpenAI база работает на полнотекстовом поиске; эмбеддинги появятся при переиндексации после ввода ключа во вкладке «Модель».

## Тесты

| Файл | Проверяет |
| --- | --- |
| `packages/opt/kb/test/chunk.test.ts` (6) | фрагменты ≤ 1 500, страницы/листы/заголовки в метаданных, строки таблиц целиком, длинные абзацы |
| `packages/opt/kb/test/core.test.ts` (5, БД с pgvector) | текст → indexed → поиск «скидка опт» без эмбеддингов; xlsx-заявка #30008823 → фрагменты с листом; эмбеддинги в pgvector и гибридный поиск; ошибки, лимиты, удаление файла; подпись источника |
| `apps/opt-api/test/kb.test.ts` (5) | `/health` с `kb_db`; приёмка этапа: текст «Скидка опт от 50 полотен — 12 %» и xlsx из #30008823 в статусе `indexed`, фрагменты видны, поиск «скидка опт» находит текст; журнал `kb_index` / `kb_search`; переиндексация, удаление, 403 для не-админа |
| `apps/opt-widget/test/opt-widget.test.tsx` (+1) | вкладка: добавление текста → «в очереди» → «проиндексирован», фрагменты, переиндексация, поиск, удаление с подтверждением |

Итог: `@opt/kb` 11, `@opt/kp` 103, `@opt/api` 24, `@opt/widget` 8 — все проходят; typecheck пяти пакетов опта чистый; `pnpm secrets` чистый. `pnpm lint` по всему репозиторию падает на 9 старых ошибках в `apps/worker`, `packages/core/db`, `packages/retail/*` — не трогал (розница и ядро не меняются); новые файлы без замечаний.

Для тестов нужна БД с расширением `vector`: в CI — образ `pgvector/pgvector:pg16` (уже так). Локально расширение собрано из исходников pgvector 0.8.0.

## Новые переменные `.env` опта

| Переменная | Значение |
| --- | --- |
| `KB_DB_PASSWORD` | пароль пользователя `aidoor_opt_kb` контейнера `opt-kb-db` (`openssl rand -hex 16`) |
| `KB_DATABASE_URL` | `postgresql://aidoor_opt_kb:<тот же пароль>@opt-kb-db:5432/ai_door_opt_kb` |
| `KB_EMBEDDING_MODEL` | необязательно, по умолчанию `text-embedding-3-small` |

Ключ OpenAI для эмбеддингов отдельно не вводится: берётся ключ аккаунта из вкладки «Модель», иначе серверный `OPENAI_API_KEY`.

## Развёртывание (один раз, после push заказчиком)

```bash
cd /opt/agent-opt/src && git fetch origin && git checkout claude/opt-kb && git pull     # или ветка, куда влит коммит
cd /opt/agent-opt
cp src/docker-compose.opt.yml docker-compose.yml
# .env: добавить KB_DB_PASSWORD и KB_DATABASE_URL (образец — src/.env.opt.example)
bash src/scripts/opt/preflight.sh                               # KB_DB_PASSWORD / KB_DATABASE_URL — OK
docker compose build opt-api opt-worker
docker compose up -d opt-kb-db                                  # первый старт создаёт БД ai_door_opt_kb
docker compose up -d opt-api opt-worker                         # opt-api применяет миграции 001_kb_init.sql
curl -s http://127.0.0.1:3001/health                            # {"status":"ok","checks":{"db":"ok","redis":"ok","kb_db":"ok"}}
docker compose logs --tail=5 opt-worker                         # «opt-worker запущен: очереди kp, kp-research, kb-index и kb-maintenance (ссылки раз в час)» — после этапа 2
docker compose exec opt-kb-db psql -U aidoor_opt_kb -d ai_door_opt_kb -c '\dt'   # kb_sources, kb_chunks, kb_prices, kb_aliases, schema_migrations
```

Виджет: собрать архив (`WIDGET_API_URL=https://opt.rf-dveri.ru pnpm opt-widget:build` в контейнере сборки, как в deploy.md), версия 1.1.0, выложить в `/opt/agent-opt/dl/` и обновить интеграцию в amoМаркете.

## Что проверить на сделке (приёмка этапа 1)

| Шаг | Ожидание |
| --- | --- |
| Настройки «Агент опт» → вкладка «База знаний» → «Текст»: `Скидка опт от 50 полотен — 12 %` → «Добавить текст» | источник в списке: «в очереди…» → через 3–6 с «проиндексирован», «фрагментов 1»; без ключа OpenAI — пометка «(без эмбеддингов)» |
| «Файл» → xlsx-заявка из сделки #30008823 (скачать из карточки сделки) | «проиндексирован», фрагментов > 0; «Фрагменты» → строки с пометкой «лист «…»» |
| «Проверить поиск» → `скидка опт` → «Найти» | первый результат — текст «Скидка опт от 50 полотен — 12 %», подпись «текст: …», способ «смысл+текст» (с ключом) или «текст» (без ключа) |
| «Журнал сборок» → фильтр «База знаний: индексация» | две записи `kb_index` с числом фрагментов и стоимостью (с ключом — доли копейки) |
| «Переиндексировать» у текста | снова «проиндексирован», фрагментов 1 |
| «Удалить» у xlsx → подтверждение | источник исчез из списка, «Занято» уменьшилось |

Этап 2 (ссылки, обход раздела, переиндексация по расписанию) — отдельным коммитом и отчётом.
