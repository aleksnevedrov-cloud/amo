# RFD-AI-AGENT-RETAIL-OCR — собственное распознавание файлов «Агента розница»

Розница, ветка `claude/reactivation-review`, база `a40f34b` (на сервере). Один коммит `RFD-AI-AGENT-RETAIL-OCR` (хеш в ответе).
`@core/docs`, `packages/opt/**`, `apps/opt-*`, `Dockerfile.opt`, `docker-compose.opt.yml` не тронуты. Настройки розницы не меняются:
значение распознавания остаётся `tesseract`, теперь за ним стоит своё распознавание розницы.

## План (до правок)

| № | Что | Где | Объём |
|---|---|---|---|
| 1 | Новый пакет `@retail/ocr`: `RetailOcr implements OcrProvider` (poppler → Tesseract → модель по картинке), от `@core/docs` только типы и `layoutPage` | `packages/retail/ocr/src/retail-ocr.ts` | ~290 строк |
| 2 | Контекст аккаунта для шага «модель» без правки `@core/docs`: обёртка `RetailDocuments` над `DocumentService.analyze` через `AsyncLocalStorage` | `packages/retail/ocr/src/context.ts` | ~40 строк |
| 3 | Подключение: worker и api при `provider === 'tesseract'` возвращают `RetailOcr`; `TesseractOcr` из `@core/docs` больше не используется розницей | `apps/worker/src/main.ts`, `apps/api/src/deps.ts` (`ocrFactory`) | ~35 строк |
| 4 | Образ розницы: `poppler-utils` (pdftoppm, pdfinfo) и `imagemagick` (HEIC / TIFF → PNG) | `Dockerfile` | 3 строки |
| 5 | Повтор упавших сканов: `files-defer.js --retry-scan-errors [--lead <id>]` → `MailAttachmentsRepo.requeueByError` | `apps/worker/src/files-defer.ts`, `packages/core/db/src/mail-attachments.ts` | ~30 строк |
| 6 | Тесты vitest без сети: 9 тестов по п. 6 ТЗ на фейках `exec` / Tesseract / модели | `packages/retail/ocr/test/retail-ocr.test.ts` | ~175 строк |
| 7 | Отчёт | `docs/retail-ocr-report.md` | — |

## Как распознаёт `RetailOcr` (п. 4 ТЗ)

| Вход | Шаг 1 | Шаг 2, если текста мало | Итог |
|---|---|---|---|
| PDF без текстового слоя | `pdfinfo` → число страниц; `pdftoppm -r 200 -png -f 1 -l 20 in.pdf page` — до 20 страниц, 60 с на файл | Tesseract `rus+eng` по странице (60 с на страницу); если `isMeaningful` даёт «мало» — страница PNG в модель аккаунта (до 8 страниц на файл, 90 с на страницу) | `--- страница N ---` + текст; у страниц от модели — `--- страница N (распознано моделью по изображению) ---`; в конце пометки в скобках |
| JPG / PNG / WEBP / BMP | Tesseract | Картинку модели при `vision.photosToClaude` показывает сам `DocumentService` (как и раньше), поэтому `RetailOcr` на картинках модель не зовёт — иначе расход удваивался бы | текст |
| HEIC / HEIF | `magick in.heic conv-%03d.png` (ImageMagick, `imagemagick-heic`) | как картинка | текст |
| TIFF (многостраничный) | `magick in.tiff conv-%03d.png` — по файлу на страницу | как картинка | текст по страницам |
| PDF с текстовым слоем | как сейчас — `extract.ts`, распознавание не вызывается | — | — |

| Правило | Как сделано |
|---|---|
| «Мало текста» | `isMeaningful` — копия критерия из `extract.ts` (≥ 5 слов из 3+ букв и ≥ 15 % токенов); `@core/docs` не экспортирует её, поэтому продублирована в `@retail/ocr` |
| Модель | Маршрут аккаунта розницы из настроек (`resolveRoute`, вкладка «Модель»), клиент через `llmFor(accountId)` → `asGateway`; берётся только если `modelTraits(provider, model).vision`. Системный запрос: «перепиши весь текст и все размеры… изделия на чертежах опиши словами… таблицы — строками, ячейки через « \| »». Ответ «(на странице нет текста)» → пустая страница |
| Лимит страниц | 20 на файл; остальные — пометка «страницы 21–N не распознаны (лимит 20 страниц на файл)» |
| Лимит модели | 8 страниц на файл; страницы сверх — пометка «часть страниц — чертежи, текст неполный» |
| Модель недоступна / `vision.photosToClaude = false` / вызов вне контекста аккаунта | Только текст Tesseract + пометка «часть страниц — чертежи, текст неполный», без ошибки |
| Таймауты | pdftoppm 60 с на файл, Tesseract 60 с на страницу, модель 90 с на страницу |
| Временные файлы | `mkdtemp` в `os.tmpdir()` (или `TMPDIR`) на каждый файл; `rm -rf` в `finally` |
| Tesseract | Один воркер на процесс (`createWorker(['rus','eng'])`, кэш `TESSERACT_CACHE_PATH`), ленивый старт; `close()` при остановке |
| Ошибки | С этапом: «растеризация: pdftoppm не установлен в образе / не уложился в 60 с / не дал ни одной страницы», «распознавание: …», «модель: …». Уходят через `OcrError` в `extract_error` и журнал, как сейчас |
| Стоимость | Tesseract и poppler бесплатно. Расход модели по страницам (`costOfUsage` по тарифу маршрута) копится в контексте и прибавляется `RetailDocuments` к `costUsd` результата `analyze` — попадает в журнал разбора (`document`, `deal_file`) и в стоимость, как сейчас |
| Дневной лимит | `vision.maxFilesPerDay` считает файл один раз: учёт ведёт `DocumentService` на уровне файла, число страниц на него не влияет |

### Что обойдено без правки `@core/docs`

| Момент | Как |
|---|---|
| `OcrProvider.recognize(bytes, mime)` не получает аккаунт и настройки | `RetailDocuments.analyze` кладёт `{ accountId, settings, route, cost, notes }` в `AsyncLocalStorage` (`ocrContext`) и оборачивает `inner.analyze`; `RetailOcr` читает его внутри вызова. В worker и api `docs` теперь `RetailDocuments`; тип `Deps.docs` — `Pick<DocumentService, 'analyze'>` (другие методы снаружи не использовались) |
| TIFF | `extract.ts` в `@core/docs` относит к картинкам только jpeg / png / webp / heic / heif — `image/tiff` до распознавания не доходит (не наш код). Ветка TIFF в `RetailOcr` готова и покрыта тестом; заработает, когда `@core/docs` начнёт передавать TIFF |
| HEIC | Без `sharp` / `heif-convert` (новых npm-зависимостей не ставим): ImageMagick из `apk` (`imagemagick` + `imagemagick-heic`, второй — `|| true`, если в репозитории Alpine его нет) |

## Повторный разбор упавших сканов (п. 5 ТЗ)

| № | Как сделано |
|---|---|
| 1 | `files-defer.js --retry-scan-errors [--lead <id>]` → `MailAttachmentsRepo.requeueByError(accountId, 'распознаётся только через Yandex Vision', 30, leadId)`: `UPDATE mail_attachments SET extract_status='deferred', extract_error='повтор после ' \|\| left(extract_error,300), extracted_at=NULL WHERE extract_status='error' AND extract_error ILIKE '%…%' AND storage_path <> '' AND created_at >= now() - 30 days [AND lead_id=$4] RETURNING …`. Команда печатает строки и завершает работу; миграция данных не нужна |
| 2 | Строки 99 и 101 сделки 30038356 подходят под условие (ошибка «Распознавание: Tesseract: скан PDF без текста распознаётся только через Yandex Vision», файлы на диске). Разбор — ближайшим проходом `wazzup-files` (`runDeferredMailFiles`, раз в 5 минут) уже через `RetailOcr`; результат — в `mail_attachments.extracted_text`, в `documents` и в журнал |
| 3 | Один раз на файл: обновление переписывает `extract_error` на «повтор после …», статус становится `deferred`; второй запуск команды такие строки не найдёт (`extract_status = 'error'` не выполняется), а при новой неудаче ошибка будет уже с этапом «растеризация / распознавание / модель» — без старого текста, под условие не подпадает |

## Тесты (п. 6 ТЗ) — `packages/retail/ocr/test/retail-ocr.test.ts`, vitest, без сети

| Тест | Проверка | Итог |
|---|---|---|
| `isMeaningful` | те же пороги, что в `extract.ts` | ✓ |
| PDF-скан из 2 страниц | `pdftoppm` вызван с `-r 200 -png -f 1 -l 2`, Tesseract — 2 раза, текст обеих страниц с заголовками `--- страница N ---`, модель не вызвана | ✓ |
| PDF-скан чертежа (Tesseract дал мусор) | страница ушла в замоканную модель картинкой PNG, текст модели в результате с пометкой «распознано моделью по изображению», стоимость учтена в контексте | ✓ |
| PDF 30 страниц | `pdftoppm … -l 20`, распознаны 20, модель — не больше 8 раз, пометки «страницы 21–30 не распознаны» и «часть страниц — чертежи, текст неполный» | ✓ |
| JPG с текстом | только Tesseract, `pdftoppm` и модель не вызваны | ✓ |
| HEIC и TIFF | `magick` → PNG, распознаны (TIFF — 2 страницы) | ✓ |
| `photosToClaude = false` и вызов вне контекста | модель не вызвана, пометка «часть страниц — чертежи, текст неполный», без ошибки | ✓ |
| Ошибки | нет `pdftoppm` → «растеризация: pdftoppm не установлен в образе», временный каталог удалён; неподдерживаемый формат → «распознавание: формат … не поддерживается» | ✓ |
| `RetailDocuments` | расход модели прибавлен к `costUsd` результата, контекст виден только внутри `analyze` | ✓ |

Фейки: `exec` отвечает на `pdfinfo` (число страниц из фикстуры), `pdftoppm` (пишет `page-N.png`), `magick` (`conv-NNN.png`), остальное — ENOENT;
Tesseract-воркер читает «текст» из тела PNG; модель — `LlmGateway.chat` с `usage`.

| Набор | Итог |
|---|---|
| `@retail/ocr` | 9 / 9 |
| `@core/docs` | 41 / 41, без правок |
| `@retail/mail` | 70 / 70, без правок |
| `@retail/agent` | 177 / 177, без правок |
| `@core/calls` | 37 / 37 |
| `@core/db` | 22 / 22 |
| `apps/worker` | 8 / 8, без правок |
| `apps/api` | 66 / 66 |
| `@opt/kp` | 150 / 150, без правок |
| `pnpm -r typecheck` | чисто |
| eslint по новым и изменённым файлам | чисто |
| Опт не затронут | `git diff --stat -- packages/core/docs packages/opt apps/opt-api apps/opt-worker apps/opt-widget Dockerfile.opt docker-compose.opt.yml` — пусто |

## Файлы коммита

| Файл | Изменение |
|---|---|
| `packages/retail/ocr/package.json`, `tsconfig.json`, `src/index.ts`, `src/context.ts`, `src/retail-ocr.ts`, `test/retail-ocr.test.ts` | новые |
| `apps/worker/src/main.ts`, `apps/api/src/deps.ts` | `RetailOcr` + `RetailDocuments` вместо `TesseractOcr` |
| `apps/worker/package.json`, `apps/api/package.json`, `pnpm-lock.yaml` | зависимость `@retail/ocr` |
| `Dockerfile` | `COPY packages/retail/ocr/package.json`, `apk add poppler-utils imagemagick (imagemagick-heic)` |
| `apps/worker/src/files-defer.ts` | флаг `--retry-scan-errors [--lead <id>]` |
| `packages/core/db/src/mail-attachments.ts` | `requeueByError` |

## Приёмка на сервере (п. 7 ТЗ, делает Claude из чата)

```bash
cd /opt/ai-door/src && git fetch origin claude/reactivation-review && git checkout claude/reactivation-review && git pull --ff-only origin claude/reactivation-review
docker compose build worker api && docker compose up -d worker api
docker compose ps; curl -s localhost:3000/health
docker compose exec worker pdftoppm -v          # poppler в образе
docker compose exec worker magick -version | head -1   # ImageMagick (HEIC / TIFF)
# вернуть в очередь сканы сделки 90287 (или без --lead — все за 30 дней)
docker compose exec worker node apps/worker/dist/files-defer.js --retry-scan-errors --lead 30038356
# через ≤ 5 минут (проход wazzup-files):
docker compose exec -T postgres psql -U aidoor -d aidoor -c "SELECT id, lead_id, filename, extract_status, left(extract_error,120) err, length(extracted_text) len, left(extracted_text,300) txt FROM mail_attachments WHERE id IN (99,101);"
docker compose logs --since 15m worker | grep -iE "ocr|распозна|растериз|Данилково"
```

Ожидание: строки 99 и 101 — `extract_status = done`, в тексте позиции дверей и размеры (страницы-чертежи — с пометкой «распознано моделью по изображению»);
в журнале — запись `document` с расходом модели, если он был. Значение распознавания в настройках розницы не менялось. «Агент опт» не пересобирался.
