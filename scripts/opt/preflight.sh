#!/usr/bin/env bash
# Этап 4, шаг 0: проверка готовности сервера к запуску «Агента опт». Ничего не меняет.
# Запуск: bash scripts/opt/preflight.sh   (переменные OPT_DIR, RETAIL_DIR, OPT_HOST, SERVER_IP — при отличиях от умолчаний)
set -u
OPT_DIR=${OPT_DIR:-/opt/agent-opt}
RETAIL_DIR=${RETAIL_DIR:-/opt/ai-door/src}
OPT_HOST=${OPT_HOST:-opt.rf-dveri.ru}
SERVER_IP=${SERVER_IP:-186.246.1.169}
ENV_FILE="$OPT_DIR/.env"
fail=0
ok()   { printf '  OK    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
warn() { printf '  WARN  %s\n' "$1"; }
val()  { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- ; }

echo "Проверка перед этапом 4 ($(date '+%Y-%m-%d %H:%M'))"

echo "1. Папки и файлы"
[ -d "$OPT_DIR/src/.git" ] && ok "клон репозитория в $OPT_DIR/src" || bad "нет клона в $OPT_DIR/src (git clone … src)"
[ -f "$OPT_DIR/docker-compose.yml" ] && ok "docker-compose.yml опта" || bad "нет $OPT_DIR/docker-compose.yml (cp src/docker-compose.opt.yml docker-compose.yml)"
if [ -f "$OPT_DIR/docker-compose.yml" ]; then
  grep -qE '^\s*context:\s*\./src\s*$' "$OPT_DIR/docker-compose.yml" && ok "контекст сборки ./src" || bad "в docker-compose.yml контекст сборки должен быть ./src (иначе Dockerfile.opt не найдётся)"
fi
[ -f "$OPT_DIR/src/Dockerfile.opt" ] && ok "Dockerfile.opt в клоне" || bad "нет $OPT_DIR/src/Dockerfile.opt"
[ -f "$ENV_FILE" ] && ok ".env опта" || bad "нет $ENV_FILE (cp src/.env.opt.example .env и заполнить)"

echo "2. Переменные .env (значения не печатаются)"
if [ -f "$ENV_FILE" ]; then
  # Обязательные переменные — те, что помечены ОБЯЗАТЕЛЬНО в .env.opt.example.
  for k in PUBLIC_URL API_PORT RETAIL_NETWORK DATABASE_URL REDIS_URL AMO_CLIENT_ID AMO_CLIENT_SECRET TOKEN_ENCRYPTION_KEY; do
    [ -n "$(val "$ENV_FILE" $k)" ] && ok "$k задан" || bad "$k пустой"
  done
  grep -qE '<пароль>|change-me' "$ENV_FILE" && bad "в .env осталась заглушка (<пароль> или change-me)"
  cid=$(val "$ENV_FILE" AMO_CLIENT_ID)
  if [ -n "$cid" ]; then
    printf '%s' "$cid" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' && ok "AMO_CLIENT_ID — UUID" || bad "AMO_CLIENT_ID должен быть UUID (ID интеграции из «Ключей и доступов»)"
  fi
  sec=$(val "$ENV_FILE" AMO_CLIENT_SECRET)
  if [ -n "$sec" ] && [ "${#sec}" -lt 16 ]; then bad "AMO_CLIENT_SECRET слишком короткий (нужен секретный ключ интеграции)"; fi
  case "$(val "$ENV_FILE" DATABASE_URL)" in *ai_door_opt*) ok "DATABASE_URL указывает на ai_door_opt";; *) bad "DATABASE_URL должен вести в БД ai_door_opt";; esac
  case "$(val "$ENV_FILE" REDIS_URL)" in */1) ok "REDIS_URL — база 1";; *) bad "REDIS_URL должен заканчиваться на /1 (у розницы база 0)";; esac
  case "$(val "$ENV_FILE" PUBLIC_URL)" in "https://$OPT_HOST") ok "PUBLIC_URL = https://$OPT_HOST";; *) bad "PUBLIC_URL должен быть https://$OPT_HOST";; esac
  key=$(val "$ENV_FILE" TOKEN_ENCRYPTION_KEY)
  if [ -n "$key" ]; then
    printf '%s' "$key" | grep -qE '^[0-9a-fA-F]{64}$' && ok "TOKEN_ENCRYPTION_KEY — 32 байта hex" || bad "TOKEN_ENCRYPTION_KEY должен быть 64 hex-символа (openssl rand -hex 32)"
  fi
  if [ -f "$RETAIL_DIR/.env" ]; then
    for k in AMO_CLIENT_ID TOKEN_ENCRYPTION_KEY; do
      r=$(val "$RETAIL_DIR/.env" $k)
      if [ -n "$r" ] && [ "$r" = "$(val "$ENV_FILE" $k)" ]; then bad "$k совпадает с розничным — у опта должен быть свой"; else ok "$k отличается от розничного"; fi
    done
  fi
fi

echo "3. DNS и сеть"
ip=$(getent hosts "$OPT_HOST" | awk '{print $1}' | head -1)
[ "$ip" = "$SERVER_IP" ] && ok "$OPT_HOST → $ip" || bad "$OPT_HOST → ${ip:-нет записи}, ожидается $SERVER_IP"
net=$(val "$ENV_FILE" RETAIL_NETWORK); net=${net:-src_default}
docker network inspect "$net" >/dev/null 2>&1 && ok "docker-сеть $net есть" || bad "docker-сети $net нет (docker network ls, поправить RETAIL_NETWORK в .env)"

echo "4. Розница"
for c in postgres redis; do
  docker compose -f "$RETAIL_DIR/docker-compose.yml" ps --status running --services 2>/dev/null | grep -qx "$c" && ok "контейнер розницы $c работает" || bad "контейнер розницы $c не запущен"
done
curl -fsS -m 5 http://127.0.0.1:3000/health >/dev/null 2>&1 && ok "api розницы отвечает на :3000" || warn "api розницы не отвечает на 127.0.0.1:3000 (если порт другой — не ошибка)"
ss -ltn 2>/dev/null | grep -q ':3001 ' && warn "порт 3001 уже занят — поменяйте API_PORT опта" || ok "порт 3001 свободен"

echo "5. Ресурсы"
free_mb=$(free -m | awk '/^Mem:/{print $7}')
[ "${free_mb:-0}" -ge 1200 ] && ok "доступно памяти ${free_mb} МБ" || bad "доступно памяти ${free_mb:-?} МБ, нужно не меньше 1200 (ТЗ раздел 10: 3072+ всего)"
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
[ "${free_gb:-0}" -ge 5 ] && ok "свободно на диске ${free_gb} ГБ" || bad "свободно на диске ${free_gb:-?} ГБ, нужно не меньше 5"

echo "6. Образ сборки виджетов"
docker image inspect ai-door-build >/dev/null 2>&1 && ok "образ ai-door-build есть" || warn "образа ai-door-build нет — архив виджета собирается в нём (см. docs/deploy-timeweb.md)"

echo
if [ "$fail" -eq 0 ]; then echo "Готово: препятствий нет."; else echo "Есть препятствия (FAIL выше). Этап 4 не начинать."; exit 1; fi
