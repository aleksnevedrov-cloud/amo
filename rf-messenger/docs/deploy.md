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
sudo mkdir -p /opt/rf-messenger && cd /opt/rf-messenger
# код — из папки rf-messenger репозитория (git clone / архив), без остального репозитория
cp .env.example .env && chmod 600 .env   # заполнить: openssl rand -hex 32 для ключей
docker compose up -d --build
docker compose ps && curl -s http://127.0.0.1:3100/health
```

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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d chat.rf-dveri.ru
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Виджет

```bash
pnpm install && WIDGET_API_URL=https://chat.rf-dveri.ru pnpm widget:build
```

Архив `widget/dist/widget.zip` загружает заказчик в интеграцию «РФ-Мессенджер».

## 6. Откат

`docker compose down` в `/opt/rf-messenger` — AI-агент и Wazzup продолжают работать как раньше.
Данные остаются в томах `pgdata`, `files`; удалить — `docker compose down -v` (только по решению заказчика).
