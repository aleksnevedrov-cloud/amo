#!/usr/bin/env bash
# Этап 4, шаг 2: БД ai_door_opt и пользователь aidoor_opt на Postgres розницы (ТЗ разделение, раздел 4).
# Запуск: OPT_DB_PASSWORD='…' bash scripts/opt/create-db.sh --dry-run   # показать SQL, ничего не делать
#         OPT_DB_PASSWORD='…' bash scripts/opt/create-db.sh             # выполнить
# Пароль — тот же, что в DATABASE_URL опта. Повторный запуск безопасен: роль и БД создаются, только если их нет.
set -euo pipefail
RETAIL_DIR=${RETAIL_DIR:-/opt/ai-door/src}
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
: "${OPT_DB_PASSWORD:?задайте OPT_DB_PASSWORD}"
case "$OPT_DB_PASSWORD" in *\'*) echo "пароль не должен содержать апостроф"; exit 1;; esac

SQL_ROLE="DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aidoor_opt') THEN CREATE ROLE aidoor_opt LOGIN PASSWORD '${OPT_DB_PASSWORD}'; END IF; END \$\$;"
SQL_DB="CREATE DATABASE ai_door_opt OWNER aidoor_opt;"
SQL_EXT="CREATE EXTENSION IF NOT EXISTS pg_trgm;"
PSQL="docker compose -f $RETAIL_DIR/docker-compose.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U aidoor"

echo "1) роль aidoor_opt (пароль скрыт):"; echo "   ${SQL_ROLE//${OPT_DB_PASSWORD}/********}"
echo "2) база ai_door_opt, если её нет:"; echo "   $SQL_DB"
echo "3) расширение pg_trgm в ai_door_opt:"; echo "   $SQL_EXT"
if [ "$DRY" -eq 1 ]; then echo "(dry-run: ничего не выполнено)"; exit 0; fi

$PSQL -d aidoor -c "$SQL_ROLE"
if $PSQL -d aidoor -tAc "SELECT 1 FROM pg_database WHERE datname = 'ai_door_opt'" | grep -q 1; then
  echo "база ai_door_opt уже есть — пропускаю"
else
  $PSQL -d aidoor -c "$SQL_DB"
fi
$PSQL -d ai_door_opt -c "$SQL_EXT"
echo "готово: $($PSQL -d aidoor -tAc "SELECT datname || ' владелец ' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'ai_door_opt'")"
