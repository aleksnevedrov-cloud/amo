# Развёртывание на сервере Timeweb Cloud (заказчик: РФ-Двери)

Инструкция для сессии, которая разворачивает бэкенд. Сервер заказчика: **Timeweb Cloud, ID 8441911, IP 186.246.1.169**,
на нём уже лежат старые виджеты amo — их не трогать, наш бэкенд живёт в отдельной папке `/opt/ai-door`.
Решение заказчика: разместить на этом сервере (отклонение от п. 0.6 ТЗ по решению заказчика — зафиксировать в отчёте).

Нужны от заказчика (он авторизуется сам в браузере): доступ в панель https://timeweb.cloud/my/servers/8441911
и, если сеть сессии это позволяет, SSH на сервер. Секреты (пароли, ключи) — только в `/opt/ai-door/.env` на сервере,
никогда в репозиторий и в чат.

## 0. Проверка сервера (ничего не менять)

```bash
ssh root@186.246.1.169
cat /etc/os-release | head -2; nproc; free -h; df -h /; uptime
docker --version; docker compose version        # есть ли Docker
ss -tlnp | grep -E ':(80|443|3000|5432|6379)\b'  # кто занял порты
ls /var/www /opt /home 2>/dev/null               # где лежат старые виджеты
```

Условия: Ubuntu/Debian, ≥ 2 ГБ свободной памяти, ≥ 5 ГБ диска. Порты 80/443 обычно заняты веб-сервером старых
виджетов (nginx/apache) — тогда наш API слушает 127.0.0.1:3000, а наружу его отдаёт тот же nginx (раздел 4).
Если Docker нет: `curl -fsSL https://get.docker.com | sh`.

## 1. Домен

Поддомен `ai.rf-dveri.ru` → A-запись на 186.246.1.169 (у регистратора rf-dveri.ru; в Timeweb — «Домены» → DNS).
Пока записи нет, можно использовать временный домен Timeweb вида `<id>.timeweb.cloud`, если он выдан серверу.
`PUBLIC_URL` в `.env` и redirect URI в интеграции amo должны совпадать с итоговым доменом.

## 2. Код и конфигурация

```bash
mkdir -p /opt/ai-door && cd /opt/ai-door
git clone https://github.com/aleksnevedrov-cloud/amo.git src   # ветка claude/new-session-j84ws6 или main
cd src && git checkout claude/new-session-j84ws6
cp .env.example .env
```

В `.env` заполнить:
- `PUBLIC_URL=https://ai.rf-dveri.ru`
- `POSTGRES_PASSWORD` — сгенерировать: `openssl rand -hex 16`; `DATABASE_URL` с этим паролем (см. docker-compose.yml)
- `TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)`
- `AMO_CLIENT_ID`, `AMO_CLIENT_SECRET` — из интеграции amo (раздел 5), можно заполнить позже
- `ANTHROPIC_API_KEY` — если заказчик даст; иначе ключ вводится в виджете («Модель»)
- `YANDEX_SPEECHKIT_API_KEY`, `YANDEX_FOLDER_ID` — если есть
- порты: если 5432/6379 на хосте заняты, в `docker-compose.yml` не публиковать их наружу (они нужны только внутри сети compose)

## 3. Запуск

```bash
cd /opt/ai-door/src
docker compose up -d --build            # postgres, redis, api (127.0.0.1:3000), worker
docker compose exec api node packages/db/dist/migrate.js 2>/dev/null || docker compose run --rm api pnpm db:migrate
curl -s http://127.0.0.1:3000/health    # {"status":"ok","checks":{"db":"ok","redis":"ok"}}
docker compose logs --tail=50 worker    # «worker запущен»
```

Если compose публикует API на 0.0.0.0:3000 — поменять на `127.0.0.1:3000:3000`, наружу только через nginx.

## 4. HTTPS через существующий nginx

```nginx
# /etc/nginx/sites-available/ai-door
server {
  listen 80;
  server_name ai.rf-dveri.ru;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 32m;   # загрузка файлов до 20 МБ в base64
  }
}
```

```bash
ln -s /etc/nginx/sites-available/ai-door /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx && certbot --nginx -d ai.rf-dveri.ru
curl -s https://ai.rf-dveri.ru/health; curl -s https://ai.rf-dveri.ru/legal/privacy | head -c 200
```

Если на сервере apache — аналогичный `ProxyPass / http://127.0.0.1:3000/` в VirtualHost. Старые виджеты не трогать:
новый server-блок только для нового поддомена.

## 5. Интеграция в amo (заказчик — в браузере, сессия — подсказывает)

amoМаркет → «Создать интеграцию» (или существующая «AI-агент»):
- Ссылка для перенаправления: `https://ai.rf-dveri.ru/oauth/amo/callback`
- Ссылка для хука об отключении: `https://ai.rf-dveri.ru/oauth/amo/disconnect`
- Доступ: «Доступ к данным аккаунта»
- Загрузить архив: собрать `WIDGET_API_URL=https://ai.rf-dveri.ru pnpm widget:build` → `apps/widget/dist/widget.zip`
- «Ключи и доступы»: ID интеграции и секретный ключ → в `.env` (`AMO_CLIENT_ID`, `AMO_CLIENT_SECRET`) → `docker compose up -d`
- Установить виджет → amo откроет `/oauth/amo/callback` → «Интеграция подключена»

## 6. После установки — по docs/install.md

Каталог (фид YML), правила цен, база знаний, песочница, Salesbot (раздел 7), почта (раздел 9), ключи Yandex.
Затем — сверка механик amo из отчётов фаз 0–4 («Что сверить на живом аккаунте») и 8 скриншотов для Маркетплейса
(список — `docs/marketplace/installation-guide.md`).

## Безопасность

- Пароль root, присланный в чат, после входа сменить: `passwd`, и добавить SSH-ключ сессии в `~/.ssh/authorized_keys`.
- `.env` — права `600`, в git не попадает (`.gitignore`).
- Не выводить содержимое `.env` и секреты в чат и логи.
