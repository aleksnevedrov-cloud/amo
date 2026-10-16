# RFD-AI-AGENT-OPT-KP-DOWNLOAD: скачивание КП из виджета и дефекты приёмки этапа 3

Дата: 16.10.2026. Ветка `claude/opt-kb`, отдельный коммит после 4d399ff (этап 4 базы знаний).
Розница и ядро не менялись (`git diff -- packages/retail apps/api apps/worker apps/widget packages/core` = 0).
Виджет 1.1.3.

## Что сделано

| Часть | Где | Содержание |
| --- | --- | --- |
| 1. Скачивание КП | `apps/opt-api/src/routes/kp.ts` (`GET /widget/v1/kp/file`, `GET /widget/v1/kp/file/link`, открытый `GET /kp/file`), `apps/opt-widget/src/components/KpBlock.tsx`, `api.ts`, `styles.css` | в блоке «Черновик КП» рядом с бейджем «Документ собран» (и после отправки) кнопки «Скачать PDF» и «Скачать DOCX» — по наличию файлов. `GET /widget/v1/kp/file?draftId=N&kind=pdf\|docx` с токеном виджета отдаёт файл как вложение: `Content-Disposition: attachment; filename="KP-KP-2026-7.pdf"; filename*=UTF-8''KP-%D0%9A%D0%9F-2026-7.pdf` (ASCII-имя плюс полное имя по RFC 6266), `Content-Length`, `Cache-Control: private, no-store`; черновик ищется только внутри `account_id` токена (`kp.byId(accountId, id)`). Из iframe amo заголовок к клику по ссылке не подставить, поэтому виджет берёт `GET /widget/v1/kp/file/link` → подписанная ссылка на открытый маршрут `GET /kp/file?draftId&kind&t=…` (HMAC-SHA256 ключом `TOKEN_ENCRYPTION_KEY`, привязана к аккаунту, черновику и виду файла, живёт 10 минут; чужая, испорченная или просроченная подпись — 403, без подписи — 400) и открывает её как `<a download>` — браузер сохраняет файл. Нет файла — 404 `no_file` «соберите документ», файл пропал с диска — 410 `file_removed` с путём |
| 2а. Относительные пути | `packages/opt/kp/src/paths.ts`, `kp-build.ts`, маршруты шаблона/сборки/отправки, миграция `005_kp_relative_paths.sql` | в базе хранятся пути относительно `KP_FILES_ROOT`: `kp/<аккаунт>/template.docx`, `kp/<аккаунт>/<сделка>/KP-….pdf`; абсолютный путь собирается при чтении (`resolveKpPath`), абсолютный путь вне корня (свой каталог сертификатов) остаётся как есть. Миграция переписывает существующие `template_path`, `certs_dir`, `docx_path`, `pdf_path` вида `/opt-data/kp/…` и `/data/kp/…` в `kp/…`; записи без «/kp/» не трогает (на проде запись, исправленную руками, миграция приведёт к тому же виду) |
| 2б. Права на каталог | `scripts/opt/entrypoint.sh`, `Dockerfile.opt`, `paths.ts` (`describeFsError`) | контейнеры opt-api и opt-worker стартуют от root через entrypoint: если `/data` или `/kb-files` принадлежат не `node`, выполняется `chown -R node:node`, затем `su-exec node` запускает процесс от `node` (пакет `su-exec` добавлен в образ, `USER node` из Dockerfile убран — права сбрасывает entrypoint). Ошибки файловой системы при сборке и загрузке шаблона пишутся в журнал `kp_error` понятным текстом: «нет прав на запись в /data/kp/28528549/30021357 (EACCES): … выполните chown -R node:node /data», «нет файла или каталога … (ENOENT): проверьте KP_FILES_ROOT и монтирование тома» |
| 2в. Пустые docx_path / kp_no / built_at | `packages/opt/kp/src/kp-build.ts` (`buildDraftDocument`), `repo.ts` (`setBuilt`) | причина, которую подтверждает код: `POST /kp/build` собирал документ по `draftId`, который виджет держал в памяти, а по сделке к тому моменту был создан новый черновик («Собрать заново» — новая запись `kp_drafts`); файлы, номер и `built_at` уходили в старую запись, виджет и `GET /kp/draft` показывают последнюю — она оставалась пустой. Теперь сборка отвергает черновик, который не последний по сделке: 409 `stale_draft` «по сделке есть более новый черновик N (этот — M): обновите блок» с `latestDraftId`; `setBuilt` возвращает, обновлена ли строка, и сборка падает с текстом, если запись не найдена; ответ сборки — свежая запись по тому же id, виджет берёт её. Сборка вынесена из маршрута в `@opt/kp` и используется и маршрутом, и утилитой |
| 2г. Утилита kp-build | `apps/opt-worker/src/kp-build.ts` | `docker compose run --rm --no-deps opt-worker node apps/opt-worker/dist/kp-build.js --account 28528549 --draft N` (или `--lead <сделка>` — последний черновик): печатает черновик, шаблон, корень файлов, затем таблицу файлов с размерами и путями от `KP_FILES_ROOT`, сертификаты, что приложено в amo и строку `kp_drafts` после записи (`status`, `kp_no`, `docx_path`, `pdf_path`, `built_at`); при отказе — код (`stale_draft`, `no_template`, `no_priced_lines`, `build_failed`) и текст, код выхода 2 |
| 3. Журнал kp_build | `kp-build.ts` | «КП КП-2026-7 собрано: позиций 12; файлы: KP-КП-2026-7.docx (41 КБ), KP-КП-2026-7.pdf (84 КБ); в сделку: KP-КП-2026-7.pdf; 3,2 с»; при сбое PDF — текст ошибки LibreOffice; details: `files[{kind, name, path, bytes}]`, `attached`, `certificates`, `kpNo`, `ms` |

## Тесты

| Пакет | Что проверяется | Итог |
| --- | --- | --- |
| `@opt/kp` (`test/paths.test.ts`) | относительные и абсолютные пути, старый том `/opt-data/kp/…` → `kp/…`, чужой каталог сертификатов без изменений; тексты EACCES/ENOENT; ASCII-имя для `Content-Disposition`; миграция 005 на реальной БД (template_path, certs_dir, docx_path, pdf_path); `setBuilt` для несуществующего черновика → false | 108 / 108 |
| `@opt/api` (`test/opt-api.test.ts`) | после сборки пути в `kp_drafts` относительные, `kp_no` и `built_at` записаны, ответ сборки с размерами файлов; журнал `kp_build` с размерами и именем приложенного файла; скачивание по токену (заголовки, PK-сигнатура, `Content-Length`), подписанная ссылка на открытый маршрут отдаёт те же байты, подпись для другого вида файла / испорченная / без `t` → 403 / 403 / 400, просроченная подпись не проходит, чужой ключ не проходит, чужой черновик — 404; сборка по устаревшему черновику → 409 `stale_draft` с `latestDraftId` | 35 / 35 |
| `@opt/widget` (`test/opt-widget.test.tsx`) | после «Собрать документ» появляются «Скачать PDF» и «Скачать DOCX», клик запрашивает `GET /kp/file/link?draftId=7&kind=pdf` и открывает ссылку как `<a download="KP-КП-2026-1.pdf">` | 18 / 18 |

typecheck `@opt/kp`, `@opt/api`, `@opt/worker`, `@opt/widget` — чистый; eslint — 9 старых ошибок в 4 нетронутых файлах; сборка opt-api, opt-worker (включая `dist/kp-build.js`) и виджета (145 КБ) — чистая.
Тесты opt-api на этой ветке требуют расширение `vector` в тестовой БД (как в базе знаний): в сессии поставлен `postgresql-16-pgvector`.

## Новые переменные `.env`

Нет. Используются существующие `KP_FILES_ROOT` (путь корня, `/data` в образе), `TOKEN_ENCRYPTION_KEY` (подпись ссылок скачивания), `PUBLIC_URL` (адрес в ссылке).

## Развёртывание

```bash
cd /opt/agent-opt && git -C src fetch origin claude/opt-kb && git -C src checkout <коммит>
cp src/docker-compose.opt.yml docker-compose.yml           # без изменений в compose, на всякий случай
docker compose build opt-api opt-worker                   # в образ добавлены su-exec и entrypoint
docker compose up -d opt-api opt-worker                   # миграцию 005 применит opt-api при старте
docker compose logs --tail=5 opt-api | grep entrypoint    # «выравниваю владельца на node», если тома были от root
cd src && WIDGET_API_URL=https://opt.rf-dveri.ru pnpm opt-widget:build && cp apps/opt-widget/dist/widget.zip /opt/agent-opt/dl/widget-opt-7c1e.zip && md5sum /opt/agent-opt/dl/widget-opt-7c1e.zip
```

В amo — обновить виджет до 1.1.3 (`?v=113`). Ручная правка `kp_settings.template_path` на проде миграцией приводится к `kp/28528549/template.docx`; если путь уже такой — миграция его не тронет.

## Приёмка (сделка #30021357 «90018»)

1. `docker compose run --rm --no-deps opt-worker node apps/opt-worker/dist/kp-build.js --account 28528549 --lead 30021357` — в выводе таблица файлов с размерами и строка `kp_drafts` с заполненными `kp_no`, `docx_path` (`kp/28528549/30021357/KP-….docx`), `pdf_path`, `built_at`; в сделке новый файл; в журнале `kp_build` с размерами.
2. В виджете «Собрать документ» → бейдж «Документ собран», рядом «Скачать PDF» и «Скачать DOCX» → файлы `KP-КП-2026-N.pdf` / `.docx` сохраняются браузером.
3. Проверка защиты: «Собрать заново» в другой вкладке, затем «Собрать документ» по старому черновику → «по сделке есть более новый черновик …», файлы не создаются.
4. Если каталог сделки был от root: в логе opt-api/opt-worker строка entrypoint о выравнивании владельца, сборка проходит; без entrypoint ошибка в журнале была бы текстом про EACCES.
