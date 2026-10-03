# AI-агент продаж дверей — виджет amoCRM

AI-агент ведёт переписку с клиентом в amoCRM как продавец дверей РФ-Двери (rf-dveri.ru).
ТЗ: v2.0 + ТЗ 1.1.0 (переключение провайдера LLM). Текущее состояние: **1.1.0 — Anthropic Claude ↔ OpenAI ChatGPT** (отчёты: [фаза 0](docs/phase-0-report.md), [фаза 1](docs/phase-1-report.md), [фаза 2](docs/phase-2-report.md), [почта](docs/email-report.md), [фаза 3](docs/phase-3-report.md), [фаза 4](docs/phase-4-report.md), [фаза 5](docs/phase-5-report.md), [1.1.0 — провайдеры LLM](docs/llm-providers-report.md); [security review](docs/security-review.md); [материалы для amoМаркета](docs/marketplace/)).

## Состав

| Путь | Назначение |
|---|---|
| `apps/api` | API Gateway (Fastify): OAuth 2.0 amo, приём Salesbot, API виджета (песочница, журнал, каталог, база знаний), `/health` |
| `apps/worker` | BullMQ: обработка входящих, обновление токенов amo, импорт фидов по расписанию |
| `apps/widget` | Виджет amo (React + TS) 1.1.0: настройки (вкладка «Модель» с двумя провайдерами), песочница со сравнением моделей и прогоном eval, журнал, аналитика по моделям, панель сделки, шаг Salesbot; сборка `widget.zip` |
| `packages/llm` | Единый интерфейс провайдера LLM: адаптеры Anthropic и OpenAI (Responses API), реестр провайдеров, таблица тарифов, резервная модель любого провайдера |
| `packages/agent` | Оркестратор на единых типах (провайдер выбирается настройкой аккаунта), пост-фильтр фактов, учёт стоимости, конвейер диалога, очередь склейки |
| `packages/tools` | Инструменты агента (по файлу на инструмент), CRM-порты amo и песочницы |
| `packages/catalog` | Импорт фида YML, поиск по каталогу |
| `packages/pricing` | Правила цен, расчёт черновика детализации, импорт/экспорт XLSX |
| `packages/media` | Расшифровка голосовых (Yandex SpeechKit, Whisper) |
| `packages/docs` | Разбор файлов клиентов: PDF/XLSX/DOCX, чертежи DWG/DXF, OCR сканов и фото (Yandex Vision, Tesseract), чистка ПДн, ГОСТ-маркировки, структура через Claude, комплект по замеру |
| `packages/mail` | Почта: опрос ящика (IMAP), ответы (SMTP), привязка писем к сделкам |
| `packages/knowledge` | База знаний: FAQ, тексты, статьи по URL |
| `packages/amo` | Клиент amoCRM: OAuth, токены, API v4, Salesbot |
| `packages/db` | PostgreSQL: миграции, аккаунты, токены, настройки + аудит, диалоги, журнал |
| `packages/shared` | Конфиг (zod), AES-256-GCM, маскирование ПДн, алерты в Telegram |
| `evals` | 52 эталонных диалога и прогон на реальной модели любого провайдера (`--model openai:gpt-5`, `--compare a,b`); нагрузочный прогон (`perf.ts`); обезличенные примеры накладных; приёмка разбора файлов (`evals/documents`) |
| `docs` | [Архитектура](docs/architecture.md), [установка](docs/install.md), [материалы для amoМаркета](docs/marketplace/) |

## Разработка

Нужны Node 22, pnpm 10, PostgreSQL 16 (с pg_trgm) и Redis 7 (или `docker compose up postgres redis`).

```bash
pnpm install
pnpm check            # lint + typecheck + тесты
pnpm build            # api, worker, widget.zip
```

Интеграционные тесты берут `TEST_DATABASE_URL` и `TEST_REDIS_URL` (по умолчанию `redis://localhost:6379`);
`TEST_DATABASE_URL`
(по умолчанию `postgres://aidoor:aidoor@localhost:5432/aidoor_test`); каждый тестовый файл работает в своей схеме.

Секреты — только в `.env` (шаблон — `.env.example`), в репозиторий не попадают.

## Групповые чаты (RFD-AI-AGENT-GRUPPOVYE-CHATY)

Агент отвечает в групповых беседах WhatsApp и Telegram только там, где разрешено.

- настройка `where.groups` (вкладка «Где работает», блок «Групповые чаты»): `mode` = allowlist | block_all | allow_all, `allowedChatIds` - chatId Wazzup.
- по умолчанию разрешён один чат - «Рабочие моменты» (79296519427-1595920633).
- `WazzupRepo.resolveChatKind(accountId, leadId, text)` определяет чат: сначала по `lead_id`, иначе по тексту в окне -3 мин / +1 мин; найденная связка записывается в `lead_id`.
- проверка стоит дважды: в hook `/salesbot/v1/hook` до вызова модели (журнал `kind=skipped`, ответ `skipped: group_chat`) и в `pipeline.ts` перед ответом.
- если чат определить не удалось (`unknown`), агент работает как обычно - молчание не по умолчанию.
- список групп и счётчик пропусков: `GET /widget/v1/wazzup/groups`.

## Комплектующие из карточки двери (RFD-AI-AGENT-KOMPLEKTUYUWIE)

У каждой двери свой набор комплектующих и свои цены, общие «Правила цен» для них не годятся.

- связки нет ни в YML-фиде, ни в `/upage/<id>.json` - единственный источник - HTML карточки
- парсер: `packages/catalog/src/components.ts`, блок `ComponentsInTheFormOfTradeOffers`, заголовок `Title FBB_CA`, инпуты `ComponentInTheFormOfTradeOffer`; первый вариант группы («не выбрано») пропускается
- хранение: таблицы `door_components` и `door_components_state` (миграция 013), TTL 24 ч, сайт не опрашивается на каждый ответ
- инструмент агента: `door_components(id)` - группы с вариантами и ценами; пустой результат - не ошибка
- `DoorComponentsRepo.stats()` даёт счётчик карточек без связки и с ошибкой разбора - вёрстка сайта может поменяться

### Обращение к агенту в группе (пункт 8)

- `where.groups.mention` (по умолчанию `@Амма`) и `where.groups.mentionOnly` (включено) - поля блока «Групповые чаты»
- Ответ в группе идёт не через Salesbot: у группового чата нет сделки, и триггер amoCRM не срабатывает.
  Вебхук Wazzup (`apps/api/src/routes/wazzup.ts`) сам зовёт `replyInGroup` (`apps/api/src/group-reply.ts`),
  ответ уходит прямо в Wazzup через `sendWazzupMessage` (`apps/api/src/wazzup-send.ts`).
- В группе агент только справочный: инструменты `catalog_search`, `catalog_get_product`, `knowledge_search`,
  `price_calculate`, `door_components`. В amoCRM не пишется ничего: ни сделок, ни задач, ни примечаний.
- Нить переписки группы — таблица `group_turns` (миграция 014), репозиторий `GroupTurnsRepo`.
  Входящие пишутся всегда, даже когда агент молчит; потолок — 20 ответов в одном чате за час.
- распознавание: `hasMention` / `stripMention` в `packages/shared/src/mention.ts`, регистр и собака не важны, «Аммадин» не срабатывает
- без обращения сообщение не доходит до модели: журнал «Группа: нет обращения к агенту», ответ hook `skipped: group_no_mention`
- с обращением слово вырезается, к тексту добавляется строка «сотрудник обратился к агенту напрямую - ответь в чат»
- после «Передачи менеджеру» обращение работает как команда: проверка паузы в `pipeline.ts` пропускается, «Возврат AI» не нужен
- личные чаты правило не затрагивает
