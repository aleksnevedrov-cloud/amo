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
WIDGET_API_URL=https://opt.rf-dveri.ru pnpm opt-widget:build      # → apps/opt-widget/dist/widget.zip
mkdir -p /opt/ai-door/dl && cp apps/opt-widget/dist/widget.zip /opt/ai-door/dl/widget-opt-7c1e.zip   # постоянная ссылка рядом с розничной
```

Интеграция «Агент опт» в amoМаркет: те же redirect и хук отключения, что в таблице выше, архив — по ссылке
`https://ai.rf-dveri.ru/dl/widget-opt-7c1e.zip`. Перед каждой выдачей архива поднять `version` в `apps/opt-widget/package.json`.

## Запуск

```bash
cd /opt/agent-opt
docker compose -f docker-compose.yml build opt-api opt-worker
docker compose up -d opt-api opt-worker          # миграции опта применяет opt-api при старте
curl -s http://127.0.0.1:3001/health             # {"status":"ok","checks":{"db":"ok","redis":"ok"}}
docker compose logs --tail=20 opt-worker         # «opt-worker запущен»
```

nginx: отдельный server-блок для `opt.rf-dveri.ru` с `proxy_pass http://127.0.0.1:3001`, сертификат certbot. Розничный блок не меняется.

## Перенос данных КП из розницы (скрипт пишется на этапе 4)

Переносятся только `kp_settings` (1 запись), `kp_drafts` (7 черновиков), ключ OpenAI и файл шаблона
`/data/kp/28528549/template.docx` → том `opt_data`, md5 сверяется. Токены amoCRM розницы не переносятся.
Старые таблицы `kp_*` в `ai_door` удаляются только на этапе 6, после дампа и подтверждения.
