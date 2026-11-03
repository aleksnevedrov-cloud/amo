# RFD-AI-AGENT-DEAL-FILES — агент сам читает файлы сделки и ссылки Яндекс Диска

Розница, ветка `claude/new-session-8uzdox`, база `1e905b4`. Два коммита: часть А — `43f1df4`, часть Б — см. ниже (хеш в ответе).
«Агент опт» не тронут.

## План (до правок)

| № | Что | Где |
|---|---|---|
| 1 | Миграция 025: `mail_attachments.source` (mail / deal_file / yadisk), таблица `deal_file_links` — только ADD | `packages/core/db/migrations/025_deal_files.sql` |
| 2 | Настройки `dealFiles` (enabled, pipelineIds, skipStatusIds, yandexDisk, maxFileMb, maxFilesPerNote) — необязательные, умолчания | `packages/core/db/src/settings.ts` |
| 3 | Журнал: `deal_file`, `deal_file_error` | `packages/core/db/src/journal.ts` |
| 4 | Задание `deal-files` в очереди `calls` раз в 5 минут: события amo, отметка `calls_sync` (entity `deal-files`), перекрытие 60 с, первый запуск за час | `packages/retail/mail/src/deal-files.ts`, `apps/worker/src/main.ts` |
| 5 | Часть А: `attachment_note_added` → сделка (или открытая сделка контакта в «Дверях») → `listLeadFiles` → `queueLeadFiles` → `deferFileToDisk` (ключ `amo-file:<uuid>`), общая функция с `files-defer` | то же, `apps/worker/src/files-defer.ts` |
| 6 | Разбор — существующим проходом `wazzup-files` (`runDeferredMailFiles`): файл сделки — приоритет «новый» (24 ч), в историю и задачу не пишется | `packages/retail/mail/src/deferred.ts` |
| 7 | Контекст агента: «Менеджер приложил файл к сделке: <имя> — <текст>», «Файл по ссылке Яндекс Диска: …»; лента дня — записью менеджера | `packages/retail/agent/src/pipeline.ts`, `wazzup-files.ts`, `packages/core/calls/src/day-sources.ts` |
| 8 | Часть Б: `common_note_added` → текст примечания → ссылки Диска → cloud-api (метаданные, скачивание, папка первого уровня) → очередь с ключом `yadisk:<key>:<path>`; лимиты, дедуп, ошибки и повторы | `packages/retail/mail/src/yadisk.ts`, `deal-files.ts`, `packages/core/db/src/deal-file-links.ts` |

## Часть А — файлы, прикреплённые к сделке

| № | Как сделано |
|---|---|
| А1 | `DEAL_FILES_JOB = deal-files`, раз в 5 минут в очереди `calls`; `calls_sync` entity `deal-files`, окно с перекрытием 60 с; без отметки — события за последний час |
| А2 | `GET /api/v4/events?filter[type][]=attachment_note_added&filter[entity][]=lead&filter[entity][]=contact&filter[created_at][from]…&to…` постранично; контакт → `GET /contacts/{id}?with=leads` → открытая сделка воронки из `pipelineIds` (самая свежая), иначе пропуск с записью в журнал |
| А3 | `listLeadFiles(leadId, 100)`; ключ `amo-file:<uuid>` → `mail_attachments.message_id = deferred:<sha1>`; строка есть — файл не ставится (тот же ключ, что у `files-defer`) |
| А4 | `deferFileToDisk(… source: 'deal_file', error: 'файл сделки, загружен менеджером')`; разбор — `runDeferredMailFiles` тем же проходом раз в 5 минут, лимит `vision.maxFilesPerDay` и доля догрузки — как у всех; файл моложе суток — приоритет `new`, старше — `backlog` |
| А5 | `dealFiles.pipelineIds` [1873498], `skipStatusIds` [142, 143]; сделка вне — запись `deal_file` «пропущены: воронка …, этап …» |
| А6 | Пропуск: файл с `amo_file_uuid` в `mail_attachments` (загрузил сам агент) и файл с тем же именем и размером у сделки (письмо, другой uuid, ссылка Диска) |
| А7 | Аудио / видео по расширению — отметка без скачивания; больше `maxFileMb` — отметка; разбор форматов — `DocumentService` как у почты |
| А8 | Пауза агента и этапы «без AI» на чтение не влияют: задание не смотрит на состояние диалога |

## Часть Б — ссылки Яндекс Диска

| № | Как сделано |
|---|---|
| Б1 | В том же задании события `common_note_added`; текст — `GET /api/v4/leads|contacts/{id}/notes/{note_id}` (id из `value_after[].note.id`), без id — текстовые примечания сущности за 2 минуты до события |
| Б2 | `yadi.sk/d`, `yadi.sk/i`, `disk.yandex.ru|com|by|kz|ua/d`, `/i`; хвостовые знаки препинания отрезаются; до `maxFilesPerNote` (10) ссылок на примечание |
| Б3 | `GET https://cloud-api.yandex.net/v1/disk/public/resources?public_key=<ссылка>&limit=50` → `type`, `name`, `size`, `mime_type`, `_embedded.items` |
| Б4 | Файл — `…/resources/download?public_key=` → `href` → скачивание (только домен `yandex.*`); папка — файлы первого уровня (вложенные папки не берутся), до `maxFilesPerNote`, скачивание по `public_key` + `path` |
| Б5 | Файл до `maxFileMb` (25) — по `size` до скачивания и по `content-length` / байтам; до 10 файлов на ссылку; до 60 МБ на примечание; сверх — запись `deal_file` с причиной, не качаем |
| Б6 | `deferFileToDisk(… source: 'yadisk', key: yadisk:<ссылка>:<path>)`, имя — `name` из Диска; дальше очередь `wazzup-files` |
| Б7 | Дубль с файлом сделки — по имени и размеру (`findByNameSize`) до скачивания (по `size` Диска) и после (по байтам): «90287» — 3 ссылки + 3 файла → 3 разбора |
| Б8 | `deal_file_links`: 404 / 403 / 410 / 400 — `failed` с текстом Диска, без повторов; 429, 5xx, сеть — `retry`, следующим проходом, не больше 3 попыток (в том же проходе не повторяется) |
| Б9 | Код ходит глобальным `fetch` на `cloud-api.yandex.net` и `downloader.disk.yandex.ru`; с сервера из этой сессии проверить нельзя — после развёртывания посмотреть журнал `deal_file_error` по первой ссылке: «сеть: …» значит прокси не пропускает, `NO_PROXY` правит заказчик |
| Б10 | Google Drive, Mail.ru Облако, Dropbox, OneDrive, iCloud — запись `deal_file` «ссылка на облако не поддерживается: <домен>», по ссылке не ходим |

## Что видит агент и менеджер

| Где | Что |
|---|---|
| Контекст агента | «Файлы в переписке» (30 дней): «[дд.мм, чч:мм] Менеджер приложил файл к сделке: <имя> — <текст>», «[…] Файл по ссылке Яндекс Диска: <имя> — <текст>»; тексты — допустимый источник цен и сроков для пост-фильтра. Блок теперь собирается и без телефона клиента |
| Итог дня и анализ отказа | Файл сделки / по ссылке — записью «Примечание менеджера [mailfile:N]: файл приложен к сделке \ Файл <имя>: <текст>» (вложения писем — как раньше, к письму) |
| Журнал виджета | `deal_file` — поставлен в разбор / разобран / пропущен с причиной / «ссылка на облако не поддерживается»; `deal_file_error` — не скачан, не разобран, ошибка Диска |
| Примечания в сделку | Не пишутся (`noteInLead` для этих файлов не применяется) |

## Настройки

`dealFiles` в настройках розницы: `enabled` true, `pipelineIds` [1873498], `skipStatusIds` [142, 143], `yandexDisk` true, `maxFileMb` 25, `maxFilesPerNote` 10. Без раздела — умолчания, строгая схема не ломается.

## Тесты (vitest, без сети)

`packages/retail/mail/test/deal-files.test.ts` (10):

| Тест | Итог |
|---|---|
| Событие `attachment_note_added` по сделке «Двери» | 3 файла в очереди, ключи `amo-file:<uuid>`, файлы на томе, журнал |
| Окно с перекрытием; тот же файл после `files-defer` | Событие на границе читается снова — строк не прибавляется; `queueLeadFiles` — «уже поставлен (ключ amo-file)» |
| Сделка в «Отказ» (143) или другой воронке; файл контакта | Ничего не ставится, журнал с причиной; файл контакта — к открытой сделке контакта |
| Аудио, файл больше лимита, файл агента, файл с тем же именем и размером | Отметки без скачивания |
| Разбор очередью | Приоритет `new`, журнал `deal_file`, в историю и задачу не пишется, файлы в `listDealFiles` |
| Разбор ссылок из текста | yadi.sk / disk.yandex.*, до 10, другие облака — домен |
| Примечание с 3 ссылками | 3 файла с именами из Диска, Google Drive — «не поддерживается», ходили только на cloud-api и downloader; повтор события — ничего нового |
| 3 ссылки + 3 тех же файла сделки | Разбор 3 раза, не 6; файлы сделки не скачивались |
| Ссылка на папку | Файлы первого уровня, 10 из 12, вложенная папка и аудио пропущены |
| 40 МБ, 404, 429 | Не скачан с причиной; 404 — `failed` с текстом Диска, без повторов; 429 — `retry` → 3 попытки → `failed`; ожившая ссылка — `done` |

`pipeline-wazzup.test.ts` (+1): строки файла сделки и ссылки Диска в контексте агента, цифры из них проходят пост-фильтр. `day.test.ts`: файл сделки в ленте дня. Попутно: тесты итога дня и очистки MP3 перестали зависеть от реальной даты (срок запуска — по `lastUpdatedAt` воркера, а не по часам БД).

Проверки: typecheck по всему workspace и eslint чистые; `@retail/mail` 70/70, `@core/calls` 37/37, `@retail/agent` 174/174, `@core/db` 22/22, `apps/worker` 8/8.

## Развёртывание

Миграция 025 — только ADD, применяется при старте api:
```bash
cd /opt/ai-door/src; git fetch origin claude/new-session-8uzdox && git checkout <хеш части Б> && docker compose build worker api && docker compose up -d worker api
docker compose logs --since 5m worker | grep -i "deal-files\|worker запущен"
```

Сделка «90287» (30038356): файлы 03.11 загружены до запуска (задание берёт события за последний час), поэтому один раз:
```bash
docker compose exec worker node apps/worker/dist/files-defer.js --lead 30038356
```
Ссылки yadi.sk из примечания «Робота» 12:14 — тоже до запуска; если они нужны — переслать примечание со ссылками заново (новое событие) или оставить: файлы те же, что в «Файлах» сделки, по имени и размеру второй раз разбираться не будут.

Проверка через ≤ 10 минут:
```sql
SELECT created_at AT TIME ZONE 'Europe/Moscow' AS msk, kind, summary FROM ai_journal WHERE lead_id = 30038356 AND kind IN ('deal_file', 'deal_file_error') ORDER BY id;
SELECT id, filename, source, extract_status, size_bytes FROM mail_attachments WHERE lead_id = 30038356 ORDER BY id;
```
Ожидание: три файла со статусом `done`, по одной строке на имя; в журнале «Разобран файл сделки «…»»; в контексте агента — «Менеджер приложил файл к сделке: …».

Сеть (Б9): если по первой ссылке Диска в журнале `deal_file_error` «сеть: …», прокси не пропускает `cloud-api.yandex.net` / `downloader.disk.yandex.ru` — поправить `NO_PROXY` на сервере.
