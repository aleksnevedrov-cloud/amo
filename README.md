# AI-агент продаж дверей — виджет amoCRM

AI-агент ведёт переписку с клиентом в amoCRM как продавец дверей РФ-Двери (rf-dveri.ru).
ТЗ: v2.0. Текущее состояние: **фаза 1 — MVP-диалог** (отчёты: [фаза 0](docs/phase-0-report.md), [фаза 1](docs/phase-1-report.md)).

## Состав

| Путь | Назначение |
|---|---|
| `apps/api` | API Gateway (Fastify): OAuth 2.0 amo, приём Salesbot, API виджета (песочница, журнал, каталог, база знаний), `/health` |
| `apps/worker` | BullMQ: обработка входящих, обновление токенов amo, импорт фидов по расписанию |
| `apps/widget` | Виджет amo (React + TS): настройки, песочница, журнал, панель сделки, шаг Salesbot; сборка `widget.zip` |
| `packages/agent` | Оркестратор на Claude, пост-фильтр фактов, учёт стоимости, конвейер диалога, очередь склейки |
| `packages/tools` | Инструменты агента (по файлу на инструмент), CRM-порты amo и песочницы |
| `packages/catalog` | Импорт фида YML, поиск по каталогу |
| `packages/knowledge` | База знаний: FAQ, тексты, статьи по URL |
| `packages/amo` | Клиент amoCRM: OAuth, токены, API v4, Salesbot |
| `packages/db` | PostgreSQL: миграции, аккаунты, токены, настройки + аудит, диалоги, журнал |
| `packages/shared` | Конфиг (zod), AES-256-GCM, маскирование ПДн, алерты в Telegram |
| `evals` | 20 эталонных диалогов и прогон на реальной модели |
| `docs` | [Архитектура](docs/architecture.md), [установка](docs/install.md) |

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
