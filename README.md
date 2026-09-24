# AI-агент продаж дверей — виджет amoCRM

AI-агент ведёт переписку с клиентом в amoCRM как продавец дверей РФ-Двери (rf-dveri.ru).
ТЗ: v2.0. Текущее состояние: **фаза 0 — каркас** (см. [отчёт](docs/phase-0-report.md)).

## Состав

| Путь | Назначение |
|---|---|
| `apps/api` | API Gateway (Fastify): OAuth 2.0 amo, хук отключения, API виджета, `/health` |
| `apps/worker` | Очередь BullMQ: плановое обновление токенов amo (далее — оркестратор) |
| `apps/widget` | Виджет amo (React + TS) и сборка `widget.zip` |
| `packages/amo` | Клиент amoCRM: OAuth, одноразовый токен виджета, сервис токенов, API v4 |
| `packages/db` | PostgreSQL: миграции, аккаунты, зашифрованные токены, настройки + аудит |
| `packages/shared` | Конфиг (zod), AES-256-GCM, маскирование ПДн, алерты в Telegram |
| `packages/tools`, `packages/catalog`, `evals` | Заготовки под фазу 1 |
| `docs` | [Архитектура](docs/architecture.md), [установка](docs/install.md) |

## Разработка

Нужны Node 22, pnpm 10, PostgreSQL 16 и Redis 7 (или `docker compose up postgres redis`).

```bash
pnpm install
pnpm check            # lint + typecheck + тесты
pnpm build            # api, worker, widget.zip
```

Интеграционные тесты БД берут `TEST_DATABASE_URL`
(по умолчанию `postgres://aidoor:aidoor@localhost:5432/aidoor_test`); каждый тестовый файл работает в своей схеме.

Секреты — только в `.env` (шаблон — `.env.example`), в репозиторий не попадают.
