# Виджет «Агент опт» 2.0.8: старые черновики КП не роняют блок

Сделка «89682» (29996635), этап «Отказ»: блок «Агент опт — КП» не открывался — `TypeError: Cannot read properties of undefined
(reading 'filter')` в `script.js?v=2.0.7`, затем «[ai-door] render error» и «AI-агент: не удалось отобразить блок». Черновик
`kp_drafts` id 8 от 12.10 (version 0): в payload нет `requirements`, `answers`, `delivery`, `priceValidity`, `letterText`,
`componentDoorGroups`, а у `source` — `skipped` и `documents`. Падал раздел «Письмо» (`SourceNotes`): `src.skipped.filter(…)`.
API отдавал 200, дефолты на сервере были только для верхнего уровня (`requirements ?? []`), вложенный `source` не трогался.

| Пункт | Реализация |
|---|---|
| 1. Виджет: дефолты | `normalizeDraft` (`KpBlock.tsx`) применяется к каждому ответу сервера (`take`): массивы — `[]` (`requirements`, `photos`, `survey`, `projectRest`, `questions`, `needsManager`, `requestItems`, `source.skipped` / `documents` / `attachments`, `mail.taken` / `uploaded` / `skipped`), объекты — `{}` / `null` (`client` со строками `''`, `delivery`, `scope`), у строк позиций — `discount 0`, `price null`, `lead_time ''`, `quoteNotes []`. Плюс точечные `?? []` там, где раньше читали `src.skipped`, `draft.needsManager`, `draft.questions`, `client.org` |
| 2. API: нормализация | `normalizeDraftPayload` (`packages/opt/kp/src/draft-normalize.ts`) в `view()` маршрутов `/kp/*`: старый payload дозаполняется при выдаче (в том же виде, что у черновиков 23.10), сам черновик в БД не меняется |
| 3. Изоляция разделов | `Section` (`KpBlock.tsx`) — граница ошибки на раздел: «Сводка», «Письмо», «Примечание», «Позиции», «Ещё в проекте», «Опросник», «Письмо и файлы». Ошибка рендера раздела → пометка «<раздел>: нет данных» и запись в консоль, остальной блок и окно работают |
| Тесты | `packages/opt/kp/test/draft-normalize.test.ts` (2): payload 12.10 и битый / пустой payload, новый payload не меняется. `apps/opt-api/test/old-drafts.test.ts` (1): черновик 12.10 в `kp_drafts` → `GET /kp/draft` 200, массивы и объекты на месте, в БД черновик не изменён. `apps/opt-widget/test/opt-widget.test.tsx` (+2): черновик формата 12.10 → блок и окно открываются, вкладки работают, пометок об ошибке нет; раздел с ошибкой рендера → «Позиции: нет данных», соседи на месте |
| Проверки | typecheck по всему workspace и eslint чистые; `@opt/kp` 150/150, `@opt/api` 80 / 8 пропущено, `opt-widget` 40/40; граница с розницей не тронута (`git diff 06d538d -- packages/retail apps/api apps/worker apps/widget packages/core` пуст) |

## Развёртывание

Сервер опта (нормализация в API):
```bash
cd /opt/agent-opt; git -C src fetch origin claude/opt-kb && git -C src checkout <хеш> && docker compose build opt-api opt-worker && docker compose up -d opt-api opt-worker
```

Виджет: `script.js` живёт внутри архива, загруженного в amoCRM (amo грузит `script.js?v=2.0.7` из него), поэтому исправление
виджета требует пересборки архива и перезалива в карточке интеграции amoМаркет. Версия 2.0.8, новое имя архива `widget-opt-2008.zip`
(location добавлен в `scripts/opt/nginx-opt.conf`, старая ссылка остаётся):
```bash
cd /opt/agent-opt/src
docker run --rm -v "$PWD":/app -w /app -e WIDGET_API_URL=https://opt.rf-dveri.ru ai-door-build sh -c 'pnpm install --frozen-lockfile && pnpm opt-widget:build'
mkdir -p /opt/agent-opt/dl && cp apps/opt-widget/dist/widget.zip /opt/agent-opt/dl/widget-opt-2008.zip
cd /opt/agent-opt && docker compose exec nginx nginx -s reload   # или перезапуск контейнера nginx после правки конфига
```
В карточке интеграции amoМаркет указать архив `https://opt.rf-dveri.ru/dl/widget-opt-2008.zip` и обновить виджет; после этого
в консоли должен грузиться `script.js?v=2.0.8`. До перезалива старые сделки открываются только за счёт нормализации в API
(достаточно для 29996635, если причина — отсутствующие поля; падение внутри раздела по другой причине закроет только раздел
уже в 2.0.8).
