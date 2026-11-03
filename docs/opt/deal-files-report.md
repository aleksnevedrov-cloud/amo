# RFD-AI-AGENT-OPT-DEAL-FILES — «Агент опт» читает сканы, чертежи и папки Яндекс Диска сделки

«Агент опт», ветка `claude/opt-kb`, база `c258cf4` (сервер). Три коммита: часть 0 — `de843c9`, часть А — `cc01389`, часть Б — см. ответ.
«Агент розница» не тронут: `git diff c258cf4 -- packages/retail apps/api apps/worker apps/widget Dockerfile` — пусто; `packages/core/docs` — пусто.
Из `@core` в ветке опта изменён только `@core/amo` (разрешено п. 0.1): карточка файла через drive_url и примечания контакта.

## План (до правок)

| № | Что | Где | Объём |
|---|---|---|---|
| 0.1 | `fileInfo` / `listLeadFileEntries`: карточка файла из Files API на `drive_url`, запасной путь — домен аккаунта; файлы без карточки — с HTTP-статусом | `packages/core/amo/src/client.ts` | +54/−6 |
| 0.2 | Черновик опта: файлы без карточки → `source.skipped` «карточка файла не получена: HTTP N» | `packages/opt/kp/src/draft.ts` | +9/−3 |
| 0.3 | Тесты: `@core/amo` (реальный формат списка), opt-api `deal-files.test.ts` | `packages/core/amo/test`, `apps/opt-api/test` | +114 |
| А1–А4 | Пакет `@opt/ocr`: `OptOcr` (poppler → Tesseract → модель опта), `OptDocuments`, `withOcrContext` | `packages/opt/ocr/src/*` | +344 |
| А5, А9 | `ocrFactory` опта → `OptOcr` при `tesseract`; `docs` / `docsFor` в `OptDocuments`; `ocrFor` базы знаний с контекстом аккаунта | `packages/opt/kp/src/deps.ts` | +34/−19 |
| А6 | `Dockerfile.opt`: `poppler-utils imagemagick (imagemagick-heic \|\| true)` | `Dockerfile.opt` | +3 |
| А тесты | 9 тестов на фейках `exec` / Tesseract / модели | `packages/opt/ocr/test/opt-ocr.test.ts` | +188 |
| Б1–Б11 | Клиент Диска (`yadisk.ts`), сбор ссылок из полей сделки и примечаний, `collectYadisk` при сборке черновика, сводка `source.yadisk` | `packages/opt/kp/src/yadisk.ts`, `draft.ts`, `job.ts`, `draft-normalize.ts`, `@core/amo` (`getEntityNotes`) | +267/−9 |
| Б10 | Виджет 2.0.10: строка «Яндекс Диск: …» в «Письме и файлах», архив `widget-opt-2010.zip` | `apps/opt-widget/*`, `scripts/opt/nginx-opt.conf` | +42/−3 |
| Б тесты | `yadisk.test.ts` (3), opt-api `deal-files.test.ts` часть Б (5), виджет (1) | — | +189 |

## Часть 0 — файлы сделки через drive_url (`de843c9`)

| № | Как сделано |
|---|---|
| 0.1 | `AmoApiClient.fileInfo(uuid)`: `GET {drive_url}/v1.0/files/{uuid}` (drive_url из `/api/v4/account?with=drive_url`, кэш на клиент = на процесс), при 404/ошибке — `GET /api/v4/files/{uuid}` на домене аккаунта. `listLeadFiles` остался (обёртка), `listLeadFileEntries` отдаёт `{ files, missing: [{ uuid, status, reason }] }`; `downloadFile` без ссылки берёт карточку через `fileInfo` |
| 0.2 | `readCard` → `card.filesMissing` → `source.skipped` и `source.files` (status `skipped`) с причиной «карточка файла не получена: HTTP N» (сеть — «сеть») |
| 0.3 | Тест `@core/amo`: ответ `/leads/30038356/files` только с `id` и `file_uuid` → запросы к `drive-a.amocrm.ru/v1.0/files/<uuid>`, два файла с именами и размерами (680 816 / 335 130), третий без карточки — в `missing` с HTTP 404. Тест opt-api: 3 файла по `file_uuid` разобраны, четвёртый без карточки — в «пропущено» |

## Часть А — своё распознавание опта (`cc01389`)

| № | Как сделано |
|---|---|
| А1 | `packages/opt/ocr` (`@opt/ocr`): `OptOcr implements OcrProvider` (`name = 'opt'`), свой код, зависит от `@core/docs` (типы, `layoutPage`), `@core/llm`, `@core/db` (тип настроек), `tesseract.js`; `@retail/*` не импортируется |
| А2 | PDF: `pdfinfo` → число страниц; `pdftoppm -r 200 -png -f 1 -l 20 in.pdf page` (60 с на файл) → Tesseract `rus+eng` по страницам (60 с на страницу, один воркер на процесс, кэш `TESSERACT_CACHE_PATH`); страницы 21+ — пометка |
| А3 | Страница, где `isMeaningful` (копия критерия `extract.ts`) даёт «мало текста», — PNG в модель опта: маршрут из контекста (`resolveOptRoute` — вкладка «Модель»), модель с поддержкой изображений (primary или fallback), до 8 страниц на файл, 90 с на страницу; запрос «Перепиши весь текст, марки, размеры, количества; таблицы — строками; ничего не додумывай»; в тексте `--- страница N (распознано моделью по изображению) ---`; нет модели / маршрута / `photosToClaude = false` — текст Tesseract с пометкой «часть страниц — чертежи, текст неполный», без ошибки |
| А4 | JPG / PNG / WEBP / BMP — Tesseract (картинку модели при `photosToClaude` показывает сам `DocumentService`); HEIC / HEIF / TIFF — `magick in.ext conv-%03d.png`, дальше как картинка (TIFF постранично). Примечание: `extract.ts` в `@core/docs` относит к картинкам только jpeg/png/webp/heic/heif — TIFF до OCR не доходит (код не наш), ветка готова |
| А5 | `ocrFactory(env, fetch, llmFor)`: `off` → null, `yandex` с ключом → `YandexVision`, иначе `OptOcr`; настройка `vision.provider` не меняется (`tesseract`) |
| А6 | `Dockerfile.opt`: `COPY packages/opt/ocr/package.json`, `apk add --no-cache poppler-utils imagemagick && (apk add --no-cache imagemagick-heic \|\| true)`. `Dockerfile` розницы не тронут |
| А7 | `OptDocuments` (AsyncLocalStorage) оборачивает `DocumentService.analyze` (и `docsFor`): кладёт аккаунт, настройки, маршрут; расход модели по страницам (`costOfUsage` по тарифу) прибавляется к `costUsd` результата → в журнал опта (`kp_draft`, файлы) как сейчас |
| А8 | Ошибки `OcrError` с этапом «растеризация: pdftoppm не установлен в образе / не уложился в 60 с / не дал страниц», «распознавание: …», «модель: …» → через `DocumentService` в причину «Файл … не разобран» (`source.skipped`, `failed: true`) в окне КП |
| А9 | `createKbCore.ocrFor` → `withOcrContext(OptOcr, аккаунт + resolveOptRoute)`: сканы прайсов в базе знаний читаются тем же путём (страницы-чертежи — моделью; расход модели здесь в журнал не пишется — `extractForKb` не ведёт стоимость) |

## Часть Б — ссылки Яндекс Диска (этот коммит)

Опт работает по кнопке — ссылки читаются в момент сборки черновика (`runDraftJob` → `buildKpDraft` с `yadisk: createYadiskClient(core.fetch)`).

| № | Как сделано |
|---|---|
| Б1 | `readCard(amo, leadId, withLinks)`: (1) все `custom_fields_values` сделки — любое поле, чьё значение содержит ссылку на облако (id поля не хардкодится; в сводке — «поле «Яндекс.Диск - Ссылка на папку»»); (2) `getEntityNotes('leads', id, 50)` и `getEntityNotes('contacts', главный контакт, 50)` — текстовые (`common`) примечания, включая робота |
| Б2 | `yadiskLinks`: `yadi.sk/d`, `/i`, `disk.yandex.ru\|com\|by\|kz\|ua/d`, `/i`; хвостовые знаки препинания отрезаются; без повторов; до 10 ссылок на черновик (сверх — «больше 10 ссылок Диска на черновик не читаем») |
| Б3 | `GET https://cloud-api.yandex.net/v1/disk/public/resources?public_key=<ссылка>[&path=/папка]&limit=50` → `type`, `name`, `size`, `mime_type`, `_embedded.items` (файлы и папки) |
| Б4 | Файл — `…/resources/download?public_key=[&path=]` → `href` только в доменах `*.yandex.net\|ru\|com\|by\|kz`, иначе ошибка без запроса. Папка — файлы первого уровня; вложенная папка читается ещё раз с `path` (второй уровень), глубже не ходим |
| Б5 | Файл больше 20 МБ (по `size` до скачивания и по байтам) — «файл больше 20 МБ (Яндекс Диск)»; общий лимит 10 файлов на черновик вместе с файлами письма и сделки — файлы Диска идут последними, сверх — «больше 10 файлов за раз не разбираем» |
| Б6 | Файл с тем же именем и размером среди файлов сделки или вложений письма (или уже взятый с другой ссылки) — «уже есть в файлах сделки или во вложениях письма — разбор один раз», не скачивается. В «90287» папка Диска и «Файлы» сделки — одни и те же PDF: разбор по одному разу |
| Б7 | Скачанное с Диска в «Файлы» сделки не загружается (в amo ничего нового не пишется) |
| Б8 | `YadiskError` (404, 403, 410 — final; 429, 5xx, сеть) — в «пропущено» с текстом Диска («Диск: Не удалось найти запрошенный ресурс. (HTTP 404)»), в сводке `type: 'error'`; сборка продолжается |
| Б9 | Сеть: в `docker-compose.opt.yml` и `.env.opt.example` репозитория прокси не задан (`NODE_USE_ENV_PROXY`, `HTTPS_PROXY` отсутствуют) — запросы идут напрямую, как у amo. Если на сервере в `.env` опта прокси включён, домены `cloud-api.yandex.net` и `downloader.disk.yandex.ru` пойдут через него; проверка — команды ниже; при отказе прокси — добавить `cloud-api.yandex.net,downloader.disk.yandex.ru` в `NO_PROXY` |
| Б10 | `source.yadisk: [{ url, where, name, type: file \| dir \| error \| unsupported, taken, skipped, error }]`; `source.attachments` и `source.skipped` — как для остальных файлов. Виджет 2.0.10: в «Письме и файлах» (раскрытие строки «Письмо: …») — «Яндекс Диск: папка Данилково, взято 2, пропущено 2 (поле «…»)», ошибка — красным, строка-статус подсвечена |
| Б11 | `drive.google.com`, `docs.google.com`, `cloud.mail.ru`, `dropbox.com`, `1drv.ms`, `onedrive.live.com`, `icloud.com` — «ссылка на облако не поддерживается: <домен>», по ссылке не ходим |

Старые черновики: `normalizeDraftPayload` пропускает `source.yadisk` только массивом — у прежних черновиков поля нет, виджет строку не показывает.

## Тесты (vitest, без сети)

| Тест | Итог |
|---|---|
| `@core/amo`: список только с `id` + `file_uuid` → карточки с drive-url, `missing` с HTTP 404 | ✓ |
| opt-api часть 0: 3 файла по `file_uuid` разобраны, 4-й без карточки — «карточка файла не получена: HTTP 404», карточки запрошены на `drive-b.amocrm.ru/v1.0/files/` | ✓ |
| `@opt/ocr`: PDF-скан из 2 страниц (`pdftoppm -r 200`, Tesseract ×2); чертёж → модель (мок) с текстом в разборе и расходом; 30 страниц → 20 + ≤ 8 в модель; JPG — только Tesseract; HEIC / TIFF через `magick`; без модели / маршрута / `photosToClaude` — пометка; ошибки с этапом, temp-каталог убран; `OptDocuments` и `withOcrContext` | 9 / 9 |
| `yadisk.test.ts`: ссылки из текста и другие облака; метаданные папки с `path`, 404 → `YadiskError`; скачивание только с домена yandex, лимит размера | 3 / 3 |
| opt-api часть Б: поле сделки → 2 файла папки разобраны, сводка «папка Данилково, взято 2», в сделку ничего не загружено; примечание робота с 3 ссылками (+ примечание контакта, + cloud.mail.ru — пометка) → 3 файла; те же 3 файла в «Файлах» сделки → разбор по одному разу, с Диска не скачивалось; 404 → «пропущено», черновик собран; 2 файла сделки + 12 на Диске → 10 разобрано, 4 в «пропущено» | 5 / 5 |
| Виджет: строка «Яндекс Диск: …», ошибка красным, статус подсвечен | ✓ |

| Набор | Итог |
|---|---|
| `@opt/kp` (с `yadisk.test.ts`) | 153 / 153 |
| `@opt/ocr` | 9 / 9 |
| `@core/amo` | 67 / 67 |
| `apps/opt-api` (все 13 файлов, включая `flow.test.ts`) | 89 passed, 8 skipped (как раньше) |
| `apps/opt-widget` (включая сборку архива 2.0.10) | 48 / 48 |
| `@opt/kb` | 71 / 72: падает `prices.test.ts` «устаревшая цена» — падает и на `c258cf4` без этих правок (ожидание по дате «прайс 01.10.2026 через 100 дней»), к задаче не относится |
| `pnpm -r typecheck`, eslint по изменённым файлам | чисто |
| Изоляция | `git diff c258cf4 -- packages/retail apps/api apps/worker apps/widget Dockerfile` — пусто; `packages/core/docs` — пусто |

## Развёртывание (делает Claude из чата)

```bash
cd /opt/agent-opt && git -C src fetch origin claude/opt-kb && git -C src checkout <хеш части Б>
docker compose build opt-api opt-worker && docker compose up -d opt-api opt-worker
docker compose ps; curl -s localhost:3001/health
docker compose exec opt-worker pdftoppm -v
docker compose exec opt-worker magick -version | head -1
# Б9: прокси и доступ к Диску из контейнера
docker compose exec opt-worker sh -c 'env | grep -i proxy; wget -qO- "https://cloud-api.yandex.net/v1/disk/public/resources?public_key=https%3A%2F%2Fyadi.sk%2Fd%2FPj7JaZqDEJJA1Q&limit=1" | head -c 300'
```

Виджет 2.0.10 (строка «Яндекс Диск» в «Письме и файлах»), архив `widget-opt-2010.zip` — location уже в `scripts/opt/nginx-opt.conf`:
```bash
cd /opt/agent-opt/src
docker run --rm -v "$PWD":/app -w /app -e WIDGET_API_URL=https://opt.rf-dveri.ru ai-door-build sh -c 'pnpm install --frozen-lockfile && pnpm opt-widget:build'
mkdir -p /opt/agent-opt/dl && cp apps/opt-widget/dist/widget.zip /opt/agent-opt/dl/widget-opt-2010.zip
md5sum /opt/agent-opt/dl/widget-opt-2010.zip; unzip -p /opt/agent-opt/dl/widget-opt-2010.zip manifest.json | grep version
cd /opt/agent-opt && docker compose exec nginx nginx -s reload
curl -sI https://opt.rf-dveri.ru/dl/widget-opt-2010.zip | head -1
```
В карточке интеграции amoМаркет указать `https://opt.rf-dveri.ru/dl/widget-opt-2010.zip`. Локальная сборка (API https://opt.rf-dveri.ru): 166 КБ,
md5 `141d7871d5666176106211bf8481e686`; md5 серверной сборки отличается (времена файлов в zip) — сверять по версии в манифесте.

Приёмка «90287» (30038356) → «Собрать заново»: «Двери внутренние Данилково (4).pdf» и «Двери наружные Данилково (4).pdf» разобраны
(позиции с размерами и количествами), «Счет покупателю № 126…» разобран (позиции из него — документ продавца, по решению модели), папка Диска —
дубли в «пропущено» («уже есть в файлах сделки…»), строка «Яндекс Диск: папка …» в «Письме и файлах». Настройки распознавания не менялись.
