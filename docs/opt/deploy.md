# «Агент опт»: развёртывание (этап 4 ТЗ разделения)

Пошаговый план со скриптами и dry-run — docs/etap-4-plan.md. Ниже — краткая справка.

## Что нужно от заказчика до начала

| № | Действие |
| --- | --- |
| 1 | Память сервера не меньше 3072 МБ, диск: не меньше 15 ГБ свободных |
| 2 | DNS: `opt.rf-dveri.ru` → 186.246.1.169 |
| 3 | Отдельная приватная интеграция amoCRM «Агент опт»: redirect `https://opt.rf-dveri.ru/oauth/amo/callback`, хук отключения `https://opt.rf-dveri.ru/oauth/amo/disconnect`; ID и секрет → `.env` опта |
| 4 | SMTP-доступ ящика, подключённого к amoCRM (логин, пароль, хост) — для отправки КП |

## Папки и база

```bash
mkdir -p /opt/agent-opt && cd /opt/agent-opt
git clone https://github.com/aleksnevedrov-cloud/amo.git src && cd src        # та же ветка, что у розницы
cp .env.opt.example ../.env && cp docker-compose.opt.yml ../docker-compose.yml  # .env правится руками
docker network ls | grep _default                                                # имя сети розницы → RETAIL_NETWORK
```

БД и пользователь опта на Postgres розницы (один раз, из папки розницы):

```bash
cd /opt/ai-door/src
docker compose exec postgres psql -U aidoor -d aidoor -c "CREATE ROLE aidoor_opt LOGIN PASSWORD '<пароль из DATABASE_URL опта>';"
docker compose exec postgres psql -U aidoor -d aidoor -c "CREATE DATABASE ai_door_opt OWNER aidoor_opt;"
docker compose exec postgres psql -U aidoor -d ai_door_opt -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

## Архив виджета «Агент опт»

```bash
cd /opt/agent-opt/src
docker run --rm -v "$PWD":/app -w /app -e WIDGET_API_URL=https://opt.rf-dveri.ru ai-door-build sh -c 'pnpm install --frozen-lockfile && pnpm opt-widget:build'   # → apps/opt-widget/dist/widget.zip; в свежем клоне нет node_modules
mkdir -p /opt/agent-opt/dl && cp apps/opt-widget/dist/widget.zip /opt/agent-opt/dl/widget-opt-7c1e.zip   # отдаёт nginx опта: location /dl/ в scripts/opt/nginx-opt.conf
```

Интеграция «Агент опт» в amoМаркет: те же redirect и хук отключения, что в таблице выше, архив — по ссылке
`https://opt.rf-dveri.ru/dl/widget-opt-7c1e.zip`. Перед каждой выдачей архива поднять `version` в `apps/opt-widget/package.json`
и обновить имя архива в `scripts/opt/nginx-opt.conf`.

## База знаний (RFD-AI-AGENT-OPT-KB, этап 1)

Отдельный контейнер `opt-kb-db` (pgvector/pgvector:pg16) в compose опта: БД `ai_door_opt_kb`, пользователь `aidoor_opt_kb`,
том данных `opt-kb-data`, том файлов источников `opt-kb-files` (смонтирован в opt-api и opt-worker как `/kb-files`).
Порт наружу не открывается. В `.env` опта: `KB_DB_PASSWORD` и `KB_DATABASE_URL` (см. `.env.opt.example`).
Миграции `packages/opt/kb/migrations` применяет opt-api при старте; `/health` отвечает `kb_db: ok`.
Ссылки (этап 2) скачивает opt-worker: страницы и файлы по адресу, обход раздела до 50 страниц, переиндексация по сроку
(очередь `kb-maintenance`, проверка раз в час) — наружу нужен доступ opt-worker к сайтам (https). Цены: прайсы xlsx импортируются во вкладке («Цены из прайса»), поиск цен в черновике идёт сначала по базе, веб-поиск — только для того,
чего в базе нет (дневной лимит $5 в настройках КП). Бэкап базы знаний — `bash src/scripts/opt/kb-backup.sh --install-cron` (ежедневно 03:40,
7 копий в `/opt/agent-opt/backups/kb/`). Подробно — [этап 1](kb-etap-1-report.md), [этап 2](kb-etap-2-report.md), [этап 3](kb-etap-3-report.md), [этап 4](kb-etap-4-report.md).

## Прайс — единый источник цен (RFD-AI-AGENT-OPT-KB-PRICELIST)

Загруженный во вкладке «База знаний» xlsx с колонками модели и цены распознаётся как прайс, цены импортируются сразу при
индексации и заменяют цены прежнего прайса аккаунта целиком (правки менеджера и веб-цены остаются); удаление файла
удаляет его цены (`kb_prices.source_id ON DELETE CASCADE`), миграция `004_kb_pricelist.sql` удаляет сирот прежних файлов.
Колонки «Сокращение в названии» и «Назначение/Конструкция» — дополнительные ключи подбора, несколько размеров в одной
ячейке дают отдельные строки, приоритет при подборе: прайс › закупка › правка менеджера › веб. Подробно — [отчёт](kb-pricelist-report.md). Раздел «Цены» во вкладке свёрнут в сводку, таблица по «Показать» с вкладками «Прайс / Веб / Правки», поиском и страницами по 20 — [отчёт](kb-prices-ui-report.md).

## Подбор цены по смыслу (RFD-AI-AGENT-OPT-KB-MATCH)

У каждой записи `kb_prices` — признаки двери (`features` jsonb, `feature_key`; миграция `005_kb_features.sql`): тип, материал,
глухая/остеклённая, створки, порог, открывание, покрытие, огнестойкость, доводчик, замок. Из прайса они берутся из колонок
«Модель», «Сокращение», «Г/О», «Покрытие», «Материал», «Конструкция», «Назначение», «Огнестойкость», из письма — из текста
позиции и явных признаков от модели разбора. Подбор: строки прайса по признакам (обязательные — тип, материал, Г/О,
покрытие, огнестойкость — не расходятся) → закупка → правка менеджера → веб; веб-запись строку прайса не перебивает,
веб-цена вне 40–300 % медианы прайса по группе признаков отбрасывается (`kp_price_error` «веб-цена N ₽ отброшена: вне
диапазона прайса»). У старых записей без признаков opt-api при старте заполняет их из текста модели (один раз).
Подробно — [отчёт](kb-match-report.md).

## Пересборка черновика и почта (RFD-AI-AGENT-OPT-KP-REBUILD-MAIL)

«Собрать заново» сначала читает письмо прошлой сборки по сохранённым папке и UID (`payload.source.mail.folder/uid`) одной
командой, без обхода папок и порций; если письма по UID нет или отправитель другой — обычный поиск. Порция FETCH ENVELOPE,
не уложившаяся в 20 с, один раз повторяется после переподключения вдвое меньшими порциями; общий бюджет поиска 150 с
(было 90). Пересборка, не давшая ни одной позиции, не создаёт пустой черновик: прежний с позициями остаётся с пометкой
«пересборка … без позиций (…) — черновик сохранён», в журнале `kp_error` «Черновик N сохранён: …». Пометки «(h)» из
спецификаций клиента в названиях не остаются. Подробно — [отчёт](kp-rebuild-mail-report.md).

## Несколько прайсов, замена по файлу (RFD-AI-AGENT-OPT-KB-MULTIPRICE)

Прайсов у аккаунта может быть несколько (межкомнатные, металлические, …). Ключ прайса — нормализованное имя файла без
расширения и хвоста версий/дат (`kb_sources.price_key`, миграция `007_kb_price_key.sql`; у старых прайсов ключ заполняет
opt-api при старте). Файл с тем же ключом заменяет только цены своего прайса (журнал и карточка файла: «прайс
«Межкомнатные» обновлён: было 54, стало N; удалено M, добавлено K»), с другим ключом — добавляет прайс рядом; удаление
файла удаляет только его цены. Подбор идёт по всем прайсам; одинаково подходящие строки в двух прайсах — берётся более
свежая с пометкой «найдено в двух прайсах». Сводка раздела «Цены»: «Прайсы: Межкомнатные — 54 цены (16.10) ·
Металлические — 21 цена (16.10)», во вкладке «Прайс» фильтр по файлу. Виджет 1.1.7. Подробно — [отчёт](kb-multiprice-report.md).

## Полное наименование позиции в КП (RFD-AI-AGENT-OPT-KP-NAME)

Название позиции хранится как написал клиент (сокращение модели разбора заменяется строкой письма без размера и
количества); в КП наименование = название клиента + «— по прайсу: модель покрытие» из строки прайса (`kb_prices.coating`,
миграция `006_kb_price_text.sql`), комплектация из колонки «Комплектация» (`kb_prices.equipment`) — строкой под позицией
(перенос в ячейке). Цвет из письма, которого нет в строке прайса, — пометка «цвет уточнить». Виджет 1.1.6 показывает
полное название с переносом, под ним модель прайса и комплектацию. Подробно — [отчёт](kp-name-report.md).

## Файлы КП и права на том (RFD-AI-AGENT-OPT-KP-DOWNLOAD)

Пути файлов КП в базе (`kp_settings.template_path`, `certs_dir`, `kp_drafts.docx_path`, `pdf_path`) хранятся относительно
`KP_FILES_ROOT` (`kp/<аккаунт>/…`), абсолютный путь собирается при чтении — смена точки монтирования тома `opt_data`
сборку не ломает; миграция `005_kp_relative_paths.sql` переписывает старые абсолютные записи. Контейнеры стартуют через
`scripts/opt/entrypoint.sh`: если `/data` или `/kb-files` принадлежат не `node` (каталоги создавались от root при переносе),
владелец выравнивается `chown -R node:node`, затем процесс запускается от `node` (`su-exec`). Ошибка прав при сборке
пишется в журнал `kp_error` текстом «нет прав на запись в … (EACCES)». Серверная проверка сборки без виджета:
`docker compose run --rm --no-deps opt-worker node apps/opt-worker/dist/kp-build.js --account 28528549 --draft N`
(или `--lead <id сделки>` — последний черновик). Скачивание собранного КП: `GET /widget/v1/kp/file?draftId=N&kind=pdf|docx`
(токен виджета) и подписанная ссылка `GET /widget/v1/kp/file/link` → открытый `GET /kp/file?…&t=…` на 10 минут.
Подробно — [отчёт](kp-download-report.md).

## Запуск

```bash
cd /opt/agent-opt
cp src/docker-compose.opt.yml docker-compose.yml   # после обновления клона: в compose появился opt-kb-db
docker compose -f docker-compose.yml build opt-api opt-worker
docker compose up -d opt-kb-db opt-api opt-worker  # миграции опта и базы знаний применяет opt-api при старте
curl -s http://127.0.0.1:3001/health               # {"status":"ok","checks":{"db":"ok","redis":"ok","kb_db":"ok"}}
docker compose logs --tail=20 opt-worker           # «opt-worker запущен: очереди kp, kp-research, kb-index и kb-maintenance (ссылки раз в час)»
```

nginx: отдельный server-блок для `opt.rf-dveri.ru` (`scripts/opt/nginx-opt.conf`: 80 → 301, 443 ssl с уже выпущенным сертификатом
`/etc/letsencrypt/live/opt.rf-dveri.ru/`, `/` → 127.0.0.1:3001, `/dl/` — архив виджета). Розничный `/etc/nginx/sites-enabled/ai-door` не меняется.

## Перенос данных КП из розницы (скрипт пишется на этапе 4)

Переносятся только `kp_settings` (1 запись), `kp_drafts` (7 черновиков), ключ OpenAI и файл шаблона
`/data/kp/28528549/template.docx` → том `opt_data`, md5 сверяется. Токены amoCRM розницы не переносятся.
Старые таблицы `kp_*` в `ai_door` удаляются только на этапе 6, после дампа и подтверждения.
