# RFD-MESSENGER — свой виджет мессенджеров для amoCRM

Отдельный проект (не часть AI-агента из корня репозитория): свой `package.json`, lock-файл,
Dockerfile и `docker compose`. Подключает мессенджеры к amoCRM через API чатов: переписка идёт
в чате карточки сделки, менеджер отвечает из amoCRM. ТЗ — RFD-MESSENGER от 03.11.2026.

Состояние: **этап 1** — каркас, БД, API чатов amoCRM, виджет, Telegram-бот ([отчёт](docs/stage-1-report.md)).

## Состав

| Путь | Что делает |
|---|---|
| `server/src/main-api.ts` | Процесс **api**: вебхук amo `/amojo/v1/hook/:scope_id`, API виджета `/widget/v1/*`, файлы `/f/:id` |
| `server/src/main-connectors.ts` | Процесс **connectors**: сессии каналов, входящие, очередь отправки (BullMQ) |
| `server/src/bridge.ts` | Мост: канал → amoCRM и amoCRM → канал, цитаты, группы, статусы доставки |
| `server/src/amojo/` | Клиент API чатов amoCRM, подписи HMAC-SHA1 |
| `server/src/connectors/` | Общий интерфейс коннектора, Telegram-бот (Bot API, long polling), запуск каналов |
| `server/src/files.ts` | Файлы у нас, в amo — подписанная ссылка на 30 дней |
| `server/src/queue.ts` | Очередь и пауза 1–3 с между исходящими в один чат |
| `server/migrations/` | Схема PostgreSQL (только вперёд) |
| `widget/` | Виджет amoCRM: каналы, статусы, подключение (только администратор) |
| `docs/` | [Заявка в amo на канал чатов](docs/amocrm-channel-request.md), [развёртывание](docs/deploy.md) |

## Разработка

```bash
cd rf-messenger
pnpm install
pnpm check     # lint + typecheck + тесты (нужны PostgreSQL 16 и Redis 7)
pnpm build     # server/dist и widget/dist/widget.zip
```

Тесты берут `TEST_DATABASE_URL` (по умолчанию `postgres://aidoor:aidoor@localhost:5432/aidoor_test`)
и `TEST_REDIS_URL` (`redis://localhost:6379`); каждый тестовый файл работает в своей схеме.

## Правила

- Секреты — только в `.env` на сервере. Токены и сессии каналов в БД зашифрованы (AES-256-GCM),
  в виджет после сохранения не возвращаются.
- Каждый запрос виджета — по `account_id` из проверенного одноразового токена amo; вебхук amo — по подписи
  канала и `scope_id`.
- Вложения из amo скачиваются только с доменов amo, с проверкой внутренних адресов и лимитом размера.
- Массовых рассылок нет: отправка возможна только ответом в существующий чат из amoCRM.
- Боевые номера не подключать до этапа 6; номер не должен быть одновременно в Wazzup и здесь.
