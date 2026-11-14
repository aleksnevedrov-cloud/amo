# Раздел «Rf Messenger» в левом меню amoCRM (как у Wazzup)

Ветка `claude/new-session-vpbkn3`, папка `rf-messenger/`. Новых зависимостей нет. Миграция `006_inbox.sql`
(поля счётчиков в `chats`, индекс `chats_inbox`) применяется сама при старте `api`.

## Правило счётчиков (единое для раздела, окна в карточке и чата amoCRM)

| Событие | Что происходит |
|---|---|
| Входящее от клиента | чат поднимается наверх, `unanswered + 1`, серый счётчик исчезает (`answered = 0`), **красный** = число неотвеченных |
| Открытие чата (любым способом) | **ничего** не меняется, `/read` больше не вызывается |
| Ответ менеджера (раздел, окно в карточке, чат amoCRM, с телефона) | `answered = unanswered`, `unanswered = 0` → **серый** счётчик; в БД `closed_by = reply`, id сообщения, сотрудник (для окна/раздела), время |
| Кнопка «Отвечать не нужно» | то же без сообщения клиенту: `closed_by = button`, кто и когда — в БД и в журнале (`chatId`, `userId`, `closed`) |
| Значок у пункта меню | число чатов с красным счётчиком (`/inbox/v1/counters`, опрос раз в 60 с + SSE на странице раздела) |

Сообщения никогда не удаляются; кнопка видна только при `unanswered > 0`.

## Что сделано

| Часть | Файлы | Суть |
|---|---|---|
| БД | `server/migrations/006_inbox.sql`, `server/src/store.ts` | `unanswered`, `answered`, `closed_by`, `closed_by_user_id`, `closed_message_id`, `closed_at`, `pinned`, `last_inbound_at`; `noteInbound`, `noteAnswered`, `inboxChats` (фильтры, поиск, курсор по 50), `unansweredChats`, `setPinned` |
| Логика | `server/src/bridge.ts`, `server/src/events.ts` | `noteCounters` в `onInbound` (клиент → красный; с телефона → закрытие), `onAmoHook` (ответ из чата amo), `sendFromWindow` (окно/раздел); `noReply`; событие SSE `counters` |
| API | `server/src/api/inbox.ts` (`/inbox/v1`), `server/src/api/chat.ts` | `GET /chats?filter=all|unanswered|mine&channelId&q&before&limit`, `GET /counters`, `GET /channels`, `POST /chats/:id/no-reply`, `POST /chats/:id/pin`, `GET /contacts/search`, `POST /chats/:id/link-contact`, `POST /chats/:id/lead`; `GET /chat/v1/chats?chatId=` (открытие из раздела), SSE `?scope=inbox`. Всё под токеном amoCRM, фильтр `account_id`, rate limit, лимиты тела |
| Права | `inbox.ts` | все сотрудники видят все чаты; при показе чата в списке менеджеру выдаётся доступ к нему на час (сообщения, отправка, SSE). «Мои» = чаты, где менеджер отвечал (его amojo-ссылка в `amo_operator_ref` или его сообщения из окна) |
| Виджет | `widget/src/inbox.ts`, `widget/src/chat.ts`, `widget/src/index.ts`, `static/manifest.json` (`left_menu`, код `rfm_inbox`), i18n | двухколоночная страница: шапка с каналом и ⋮ (выбор канала), поиск, фильтры, строки (аватар-инициалы, значок канала, группа 👥, превью с файлом, время/«Вчера»/дата, красный/серый счётчик, меню ⌄: открыть сделку / закрепить / «Отвечать не нужно»), «Показать ещё» + подгрузка прокруткой по 50; справа — то же окно переписки, что в карточке (встроенный режим): 🔍, 👤+ (поиск/привязка контакта), «Сделки ▾» со списком и «+ Создать сделку», ⋮, красная кнопка «Отвечать не нужно N», композер с 📎 / «/»-шаблонами / 😊 / Enter / 🎤 |
| Тесты | `server/test/inbox.test.ts` (7), `server/test/chat-window.test.ts`, `widget/test/inbox.test.ts` (7), `widget/test/chat.test.ts` | правило счётчиков из 3 мест + кнопка + новое входящее; фильтры; поиск; сортировка и закрепление; пагинация 55 → 50 + 5; права (401, менеджер); SSE `scope=inbox`; рендер строк; раздел в jsdom (открытие ≠ прочитано, ответ → серый, кнопка, меню, значок) |

`pnpm check`: lint, secrets, typecheck, server 184 теста, widget 31 тест — зелёные. Сборка `widget.zip` — 9 файлов.

## Скриншоты (`docs/screenshots/`)

`6-inbox-list.png` — список: красные (3, 1) и серые (1, 4, 2) счётчики, закреплённый чат, группа, превью файла, значок «2» у пункта меню ·
`7-inbox-dialog-noreply.png` — диалог с кнопкой «Отвечать не нужно 3» ·
`8-inbox-deals-menu.png` — меню «Сделки» с «+ Создать сделку» ·
`9-inbox-after-reply.png` — после ответа: кнопки нет, счётчик серый «3», значок меню «1» ·
`10-inbox-group-row-menu.png` — групповой чат и меню строки.

## Что нужно проверить в живом amoCRM (не воспроизводится в макете)

1. **Контейнер страницы раздела.** Виджет ищет `#work-area-<код виджета>` / `#work-area-rfm_inbox` / `.work-area`; если ничего нет — рисует свой контейнер на весь экран правее меню. Если страница откроется пустой, нужен селектор из реального DOM (один `querySelector` в `inboxHost`).
2. **Область `render`.** Раздел монтируется, когда `self.system().area` равно `rfm_inbox`, `rfm_inbox_page` или `left_menu`. Если amo передаёт другое значение — добавить в условие в `index.ts`.
3. **Значок меню.** Используется `self.set_badge`, если amo его даёт; иначе свой элемент у ссылки с `rfm_inbox` в адресе.
4. Иконка пункта меню — `images/logo_min.png` из виджета.

## Развёртывание (текст для серверного чата, DigitalOcean)

```bash
cd /opt/rf-messenger && git fetch origin && git checkout claude/new-session-vpbkn3 && git pull --ff-only
docker compose build api connectors && docker compose up -d api connectors
docker compose logs api --since 2m | grep -i -E "006_inbox|миграц|listen" 
curl -s -o /dev/null -w "%{http_code}\n" https://chat.rf-dveri.ru/inbox/v1/counters   # ожидается 401 без токена
```

Виджет: `pnpm build` → `widget/dist/widget.zip` → загрузить в интеграцию amoCRM (новая версия манифеста с `left_menu`),
переустановить виджет в аккаунте, обновить страницу amo — слева появится пункт «Rf Messenger».

Откат: `git checkout 6dd09bd && docker compose build api connectors && docker compose up -d api connectors`;
колонки миграции 006 старому коду не мешают, удалять не нужно. Виджет — загрузить предыдущий `widget.zip`.

## Дополнение: кнопка «Сохранить» в окне настроек

`placeSaveButton` (`widget/src/index.ts`) вызывается из `settings()` и переносит **штатный** элемент amoCRM
`.js-widget-save` в правый верхний угол окна: под «Редактировать» (та же ширина, отступ 8 px), без неё — на её место
(`top:16px; right:24px`). Кнопка не подменяется: обработчики amo и состояние активна/неактивна сохраняются; для
`type=submit` вне формы выставляется атрибут `form`. Пустая строка `.widget_settings_block__controls` скрывается,
описание и баннеры поднимаются. Если разметка не распознана — кнопка остаётся на месте. Тест: `widget/test/widget.test.ts`
(«кнопка «Сохранить» в окне настроек»). Скриншоты: `11-settings-save-before.png`, `12-settings-save-after.png`,
`13-settings-save-no-edit.png`. Серверная часть не менялась — достаточно загрузить новый `widget.zip`.
