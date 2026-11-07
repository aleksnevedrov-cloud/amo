# Развёртывание на сервере Timeweb «Amo Widget» (186.246.1.169)

Отдельный проект в `/opt/rf-messenger` со своим `docker compose`. Папки и контейнеры AI-агента
и старых виджетов не трогаются.

## 1. До установки (заказчик)

- DNS в nic.ru: `chat.rf-dveri.ru  A  186.246.1.169`.
- Интеграция «РФ-Мессенджер» в amoCRM и заявка на канал чатов — `docs/amocrm-channel-request.md`.

## 2. Ресурсы

Перед запуском: `free -m` и `docker stats --no-stream`. Замер этапа 1 (локально, Node 22):

| Контейнер | Ограничение | Факт RSS, бот без нагрузки |
|---|---|---|
| api | 160 МБ | ≈ 95 МБ |
| connectors (Telegram-боты) | 256 МБ | ≈ 98 МБ |
| postgres (shared_buffers 32 МБ) | 160 МБ | ≈ 40–60 МБ (оценка) |
| redis | 64 МБ | ≈ 5–10 МБ |
| **Итого этап 1** | | **≈ 250–270 МБ** |

Оценка на следующие этапы: WhatsApp (Baileys) — 100–200 МБ на номер, Telegram личный (GramJS) —
80–150 МБ на аккаунт. При свободных ≈ 0,9 ГБ хватит на этап 1 и один тестовый номер WhatsApp;
для нескольких боевых номеров WhatsApp и Telegram нужен тариф с 4 ГБ — сообщить заказчику до этапа 2.

## 3. Установка

```bash
# Код — только папка rf-messenger репозитория (sparse checkout), рабочая копия в /opt/rf-messenger/src.
sudo mkdir -p /opt/rf-messenger && sudo chown "$USER" /opt/rf-messenger && cd /opt/rf-messenger
git clone --filter=blob:none --sparse -b claude/new-session-vpbkn3 https://github.com/aleksnevedrov-cloud/amo src
git -C src sparse-checkout set rf-messenger
cd src/rf-messenger
cp .env.example .env && chmod 600 .env
# Заполнить: POSTGRES_PASSWORD, ENCRYPTION_KEY, FILE_URL_SECRET (openssl rand -hex 32),
# AMO_ACCOUNT_IDS — обязателен (без него сервис не стартует), AMO_CLIENT_ID/SECRET — после создания интеграции.
docker compose up -d --build
docker compose ps && curl -s http://127.0.0.1:3100/health
```

До создания интеграции «РФ-Мессенджер» `AMO_CLIENT_ID` и `AMO_CLIENT_SECRET` неизвестны: временно задать
`AMO_CLIENT_ID` любым UUID и `AMO_CLIENT_SECRET` случайной строкой — виджет не авторизуется, пока их не заменят.

## 4. nginx и сертификат

```nginx
server {
    listen 80;
    server_name chat.rf-dveri.ru;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name chat.rf-dveri.ru;
    ssl_certificate     /etc/letsencrypt/live/chat.rf-dveri.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.rf-dveri.ru/privkey.pem;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        # Перезаписываем, а не дописываем: сервис доверяет ровно одному прокси (trustProxy).
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Порядок: сначала включить только блок `listen 80` (без него и без DNS сертификат не выпустить),
`sudo nginx -t && sudo systemctl reload nginx`, затем выпустить сертификат и добавить блок `listen 443`:

```bash
sudo mkdir -p /var/www/letsencrypt
sudo certbot certonly --webroot -w /var/www/letsencrypt -d chat.rf-dveri.ru
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Виджет

```bash
pnpm install && WIDGET_API_URL=https://chat.rf-dveri.ru pnpm widget:build
```

Архив `widget/dist/widget.zip` загружает заказчик в интеграцию «РФ-Мессенджер».

## 6. Прокси для Telegram и WhatsApp, проверка и уведомления

С сервера в РФ Telegram и WhatsApp режутся, поэтому трафик к ним идёт через прокси. amoCRM, postgres и redis —
всегда напрямую. Значения — только в `.env`, в журналах адрес прокси, логин, пароль и токены не печатаются.

| Переменная | Обязательна | Что делает |
|---|---|---|
| `MESSENGER_PROXY_URL` | нет | Основной HTTP(S)-прокси: `http://логин:пароль@хост:порт`. Пусто — напрямую |
| `MESSENGER_PROXY_URL_FALLBACK` | нет | Запасной прокси. После 3 неудачных проверок основного подряд Telegram и WhatsApp переходят на запасной, после 3 удачных — обратно. Каждое переключение — строка в журнале connectors |
| `ALERT_TG_BOT_TOKEN` | нет | Токен бота для уведомлений о сбоях (задаётся вместе с `ALERT_TG_CHAT_ID`) |
| `ALERT_TG_CHAT_ID` | нет | Чат, куда бот пишет уведомления |

Как это работает:

- **Проверка прокси** — раз в 60 с процесс connectors открывает через прокси `https://api.telegram.org/`
  (таймаут 10 с). Результат — в Redis `rfm:proxy:status` и в `GET /health`: поле `proxy` (`ok`, `fail`,
  `direct` — прокси не задан, `stale` — проверка не обновлялась больше 3 мин, `unknown` — проверок ещё не было),
  `proxyActive` (`primary`/`fallback`), `proxyCheckedAt`, `proxyLatencyMs`.
- **Telegram** — каждый запрос (getUpdates, отправка, скачивание файлов) при сетевой ошибке, таймауте,
  429 и 5xx повторяется до 5 раз с паузой 1–2–4–8–16 с (±25 %); для 429 — пауза из `retry_after`.
  Успешный ответ не повторяется.
- **WhatsApp** — при обрыве (кроме «устройство отключено на телефоне») переподключение с паузой
  2–4–8–16–32–60 с, сессия сохраняется, QR заново не нужен. Если прокси отказал в соединении
  (HTTP 403 и т. п.) или WhatsApp не ответил за 45 с — попытка обрывается и повторяется.
- **Уведомления** — если прокси или канал Telegram-бот/WhatsApp не в статусе «подключён» дольше 5 мин,
  бот пишет в чат: что сломалось, с какого времени, название канала и id; при восстановлении — второе сообщение.
  По одной проблеме — не чаще одного сообщения о сбое в 30 мин. Уведомления идут через текущий прокси.

Ввод секретов без вывода на экран (выполнить в `/opt/rf-messenger/src/rf-messenger`, затем перезапустить connectors):

```bash
set_env() { read -rsp "$1: " v; echo; sed -i "/^$1=/d" .env; [ -n "$v" ] && printf '%s=%s\n' "$1" "$v" >> .env; unset v; }
set_env ALERT_TG_BOT_TOKEN; set_env ALERT_TG_CHAT_ID; set_env MESSENGER_PROXY_URL_FALLBACK
docker compose up -d connectors
```

Прокси должен пропускать туннель (CONNECT, порт 443) к `api.telegram.org`, `web.whatsapp.com`,
`*.whatsapp.net` и `*.whatsapp.com`. Проверка из контейнера: `GET /health` → `proxy: ok`;
для WhatsApp — ключ `rfm:wa:qr:<id канала>` в Redis появляется в течение 15 с после «Новый QR».

## 7. MAX, VK и Авито (этап 4)

Новых переменных `.env` нет. Каналы подключаются из виджета ключами, которые вводит заказчик; ключи хранятся
зашифрованными. MAX, VK и Авито — российские сервисы, идут **напрямую**, минуя прокси.

- **MAX** — long polling `platform-api.max.ru`, внешний адрес не нужен.
- **VK** — Bots Long Poll API, внешний адрес не нужен. Если у ключа нет права «Управление сообществом»,
  Long Poll и событие «Входящее сообщение» заказчик включает в настройках сообщества сам.
- **Авито** — вебхук `https://chat.rf-dveri.ru/hooks/avito/<id канала>/<секрет>` (строится из `PUBLIC_URL`);
  путь `/hooks/` должен доходить до сервиса через nginx (при `location /` — доходит). Если подписка не удалась,
  канал работает опросом раз в минуту и показывает это в статусе.

Подробности и приёмка — `docs/stage-4-report.md`.

## 8. Откат

`docker compose down` в `/opt/rf-messenger` — AI-агент и Wazzup продолжают работать как раньше.
Данные остаются в томах `pgdata`, `files`; удалить — `docker compose down -v` (только по решению заказчика).
