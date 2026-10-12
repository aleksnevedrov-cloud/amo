# Этап 4: развёртывание «Агента опт» на сервере — пошаговый план

ТЗ: docs/tz-razdelenie-roznica-opt.md, разделы 4, 6.2, 10. Сервер: Timeweb, IP 186.246.1.169, тариф Ultra 4 ГБ.
Розница (`/opt/ai-door/src`, контейнеры api, worker, postgres, redis) в ходе этапа не останавливается и не пересобирается.
Опт живёт в `/opt/agent-opt`, пользуется Postgres и Redis розницы через их docker-сеть: своя БД `ai_door_opt`, Redis база 1.

Скрипты этапа — в `scripts/opt/`; у каждого есть режим проверки без изменений (dry-run).

| Скрипт | Что делает | Dry-run |
| --- | --- | --- |
| preflight.sh | проверяет .env опта, DNS, docker-сеть, контейнеры розницы, порт 3001, память и диск | всегда только читает |
| create-db.sh | роль aidoor_opt, БД ai_door_opt, расширение pg_trgm на Postgres розницы | `--dry-run` печатает SQL |
| nginx-opt.conf | server-блок для opt.rf-dveri.ru → 127.0.0.1:3001 | файл копируется руками |
| check-bundles.sh | после сборки: ни один пакет воркспейса не остался внешним импортом бандла | `--dry-run` печатает команды |
| migrate-kp-data.sh | перенос kp_settings, kp_drafts, ключа OpenAI и шаблона с проверкой md5 из ai_door в ai_door_opt | без `--apply` только показывает |

## Что нужно от заказчика до запуска и куда это подставляется

| № | Что | Куда подставляется | Шаг плана |
| --- | --- | --- | --- |
| 1 | Память ≥ 3072 МБ и диск ≥ 15 ГБ свободных (тариф Ultra 4 ГБ — выполнено) | проверяет preflight.sh | 0 |
| 2 | DNS-запись `opt.rf-dveri.ru` → 186.246.1.169 у регистратора | проверяет preflight.sh; нужна для сертификата | 0, 4 |
| 3 | Отдельная приватная интеграция amoCRM «Агент опт»: redirect `https://opt.rf-dveri.ru/oauth/amo/callback`, хук отключения `https://opt.rf-dveri.ru/oauth/amo/disconnect`, доступ «Доступ к данным аккаунта». Из «Ключей и доступов» — ID интеграции и секретный ключ | `AMO_CLIENT_ID`, `AMO_CLIENT_SECRET` в `/opt/agent-opt/.env` | 1 |
| 4 | SMTP ящика, подключённого к amoCRM: хост, порт, логин, пароль | вкладка «Письмо» виджета опта (хост, порт, логин) и поле «Пароль SMTP» там же | 9 |
| 5 | Пароль для пользователя БД aidoor_opt (придумать) | `OPT_DB_PASSWORD` при запуске create-db.sh и `DATABASE_URL` в `.env` опта | 1, 2 |
| 6 | Ключ OpenAI | переносится скриптом из розницы (шаг 7); если переноса не будет — ввести во вкладке «Модель» | 7 или 9 |

Ключи розницы в опт не копируются: два сервиса не могут обновлять один refresh-токен amoCRM (ТЗ 6.2).

## Порядок (правило деплоя: миграция → сборка образов → перезапуск → только потом настройки в виджете)

### Шаг 0. Проверка готовности (ничего не меняет)

```bash
mkdir -p /opt/agent-opt && cd /opt/agent-opt
git clone https://github.com/aleksnevedrov-cloud/amo.git src && cd src && git checkout claude/new-session-8uzdox   # та же ветка, что у розницы
cp .env.opt.example ../.env && cp docker-compose.opt.yml ../docker-compose.yml
bash scripts/opt/preflight.sh
```

Пока preflight показывает FAIL, дальше не идти. `.env` заполняется на шаге 1, после него preflight повторить.

### Шаг 1. `.env` опта

`/opt/agent-opt/.env` по `.env.opt.example`: `PUBLIC_URL=https://opt.rf-dveri.ru`, `API_PORT=3001`, `RETAIL_NETWORK` (имя сети розницы из
`docker network ls`, обычно `src_default`), `DATABASE_URL=postgres://aidoor_opt:<пароль из п. 5>@postgres:5432/ai_door_opt`,
`REDIS_URL=redis://redis:6379/1`, `AMO_CLIENT_ID` и `AMO_CLIENT_SECRET` из п. 3, `TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)` — свой, не розничный.
Права `chmod 600 /opt/agent-opt/.env`.

### Шаг 2. БД ai_door_opt (Postgres розницы, без перезапуска)

```bash
cd /opt/agent-opt/src
OPT_DB_PASSWORD='<пароль из п. 5>' bash scripts/opt/create-db.sh --dry-run
OPT_DB_PASSWORD='<пароль из п. 5>' bash scripts/opt/create-db.sh
```

Redis база 1 отдельного создания не требует: `REDIS_URL=…/1` выбирает её при подключении.

### Шаг 3. Сборка образов (миграции опта применит opt-api при первом старте, шаг 5)

```bash
cd /opt/agent-opt
docker compose build opt-api opt-worker
```

Сборка падает, если какой-то пакет воркспейса не встроился в бандл (защита в scripts/build-app.mjs). Дополнительно:

```bash
bash src/scripts/opt/check-bundles.sh --dry-run    # показать команды
bash src/scripts/opt/check-bundles.sh              # OK по обоим образам — можно запускать
```

### Шаг 4. nginx и сертификат

```bash
cp /opt/agent-opt/src/scripts/opt/nginx-opt.conf /etc/nginx/conf.d/agent-opt.conf
nginx -t && systemctl reload nginx
certbot --nginx -d opt.rf-dveri.ru
```

Розничный `ai-door.conf` не трогается. Сертификат выпускается только после DNS (п. 2).

### Шаг 5. Запуск опта (миграции → контейнеры)

```bash
cd /opt/agent-opt
docker compose up -d opt-api              # при старте применяет миграции 001, 002 в ai_door_opt
docker compose logs --tail=30 opt-api     # «миграции применены», без ошибок подключения к БД и Redis
curl -s http://127.0.0.1:3001/health      # {"status":"ok","checks":{"db":"ok","redis":"ok"}}
curl -s https://opt.rf-dveri.ru/health    # то же снаружи
docker compose up -d opt-worker
docker compose logs --tail=20 opt-worker  # «opt-worker запущен»
```

`up -d` без `build` контейнер не пересоздаёт: после любого изменения кода — сначала шаг 3.

### Шаг 6. Интеграция и виджет в amoCRM

```bash
cd /opt/agent-opt/src
docker run --rm -v "$PWD":/app -w /app -e WIDGET_API_URL=https://opt.rf-dveri.ru ai-door-build pnpm opt-widget:build
mkdir -p /opt/ai-door/dl && cp apps/opt-widget/dist/widget.zip /opt/ai-door/dl/widget-opt-7c1e.zip
```

В карточку интеграции «Агент опт» (п. 3) загрузить архив по ссылке `https://ai.rf-dveri.ru/dl/widget-opt-7c1e.zip`, установить.
amo откроет `/oauth/amo/callback` опта → страница «Аккаунт … подключён к «Агенту опт»». В БД опта появляется строка accounts
и токены — без неё шаг 7 остановится.

### Шаг 7. Перенос данных КП из розницы (ТЗ 6.2)

```bash
cd /opt/agent-opt/src
bash scripts/opt/migrate-kp-data.sh            # dry-run: что перенесётся, md5 шаблона
bash scripts/opt/migrate-kp-data.sh --apply
```

Переносятся: kp_settings (1 запись), kp_drafts (7 черновиков, с теми же id), ключ OpenAI (перешифровывается ключом опта),
файл `template.docx` в том opt_data с проверкой md5 до и после. Токены amoCRM розницы не переносятся. Исходная БД только читается.
Таблицы kp_* в ai_door не удаляются — это этап 6, после дампа и подтверждения.

### Шаг 8. Замер памяти (точка решения из раздела 5 ТЗ)

```bash
docker stats --no-stream opt-api opt-worker src-api-1 src-worker-1
free -m
```

Ожидание: opt-api и opt-worker в сумме до ~400 МБ в покое; под нагрузкой свободно не меньше 500 МБ (ТЗ раздел 11).

### Шаг 9. Настройки в виджете опта (только после шагов 3–5)

| Вкладка | Что вводится |
| --- | --- |
| Модель | провайдер и модель (по умолчанию OpenAI gpt-5.5, резерв gpt-5.1); ключ — перенесён шагом 7, иначе ввести |
| КП | константы перенесены; проверить, что шаблон показан как загруженный, md5 совпадает со старым |
| Письмо | SMTP из п. 4, отправитель, копия, шаблоны темы и текста, пароль SMTP |
| База знаний | справочники по шаблонам — по готовности документов заказчика (этап 8) |

### Шаг 10. Приёмка этапа 4

| Проверка | Критерий (ТЗ раздел 11) |
| --- | --- |
| `/health` опта | ok снаружи и изнутри |
| Черновики КП | 7 штук в ai_door_opt, открываются в новом виджете |
| Шаблон kp.docx | md5 совпадает со старым (вывод migrate-kp-data.sh и вкладка «КП») |
| Розница | api и worker розницы не перезапускались, тестовый диалог отвечает как раньше |
| Память | docker stats, свободно ≥ 500 МБ |
| Изоляция | `docker compose stop opt-api opt-worker` в /opt/agent-opt никак не влияет на розницу, и наоборот |

Живая заявка (сделка 89835, «Двери (3).docx», 11 позиций) — этап 5, после приёмки этапа 4. Там же сверяется формат API файлов amoCRM.

## Откат

`cd /opt/agent-opt && docker compose down` останавливает только опт. БД ai_door_opt и том opt_data остаются и не мешают рознице;
удалять их не нужно. Розница при откате не затрагивается.
