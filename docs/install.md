# Установка (фаза 0)

## 1. Сервер

Отдельный сервер в РФ (не amo.rf-dveri.ru), Docker + Docker Compose, публичный HTTPS-домен
(например `ai-agent.rf-dveri.ru`) с обратным прокси (nginx/Caddy) на `127.0.0.1:3000`.

```bash
cp .env.example .env
openssl rand -hex 32        # → TOKEN_ENCRYPTION_KEY
# заполнить PUBLIC_URL, POSTGRES_PASSWORD, DATABASE_URL, AMO_CLIENT_ID, AMO_CLIENT_SECRET
docker compose up -d --build
curl https://ai-agent.rf-dveri.ru/health   # {"status":"ok",...}
```

Миграции БД применяются автоматически при старте `api`.

## 2. Интеграция в amoCRM (aleksnevedrov)

1. «amoМаркет» → «Создать интеграцию» → «Внешняя интеграция».
2. **Ссылка для перенаправления:** `https://<PUBLIC_URL>/oauth/amo/callback`.
3. **Ссылка для хука об отключении:** `https://<PUBLIC_URL>/oauth/amo/disconnect`.
4. Доступ: «Доступ к данным аккаунта» (+ «Уведомления» и «Чаты» — понадобятся в фазе 1).
5. Загрузить архив виджета `widget.zip` (см. ниже).
6. Скопировать ID интеграции и секретный ключ из вкладки «Ключи и доступы» в `.env`
   (`AMO_CLIENT_ID`, `AMO_CLIENT_SECRET`) и перезапустить: `docker compose up -d`.
7. Установить виджет в аккаунте. amo вызовет redirect URI, и бэкенд сохранит токены.
   Страница ответит «Интеграция подключена».

Если интеграция уже была создана с другим redirect URI, его нужно поменять на адрес из п. 2:
amo передаёт `redirect_uri` при каждом обмене и обновлении токена.

## 3. Архив виджета

```bash
WIDGET_API_URL=https://ai-agent.rf-dveri.ru pnpm widget:build
# → apps/widget/dist/widget.zip
```

`WIDGET_API_URL` вшивается в `script.js`. Логотипы в архиве — временные заглушки,
их нужно заменить на фирменные тех же размеров (130×100, 400×272, 240×84, 84×84, 108×108).

## 4. Проверка приёмки фазы 0

- Карточка сделки → правая колонка → блок виджета показывает «Статус AI: Выключен».
- Настройки → виджет → расширенные настройки: «amoCRM подключён».
- Токен обновляется: в `amo_tokens.refreshed_at` через сутки новая дата
  (или для проверки сразу: `TOKEN_REFRESH_MARGIN_SEC=86400` и перезапуск `worker`).
