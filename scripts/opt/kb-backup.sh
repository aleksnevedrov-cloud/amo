#!/usr/bin/env bash
# База знаний опта (RFD-AI-AGENT-OPT-KB, этап 4): pg_dump БД ai_door_opt_kb из контейнера opt-kb-db раз в сутки,
# в /opt/agent-opt/backups/kb/, хранить 7 последних копий. Ничего, кроме каталога бэкапов, не меняет.
#
# Запуск руками:   bash /opt/agent-opt/src/scripts/opt/kb-backup.sh            # сделать копию сейчас
#                  bash /opt/agent-opt/src/scripts/opt/kb-backup.sh --dry-run  # показать команды, ничего не делать
# Установка cron:  bash /opt/agent-opt/src/scripts/opt/kb-backup.sh --install-cron   # строка в crontab root: ежедневно 03:40
# Восстановление:  gunzip -c /opt/agent-opt/backups/kb/kb-YYYYmmdd-HHMM.sql.gz | docker compose -f /opt/agent-opt/docker-compose.yml exec -T opt-kb-db psql -U aidoor_opt_kb -d ai_door_opt_kb
set -euo pipefail
OPT_DIR=${OPT_DIR:-/opt/agent-opt}
BACKUP_DIR=${KB_BACKUP_DIR:-$OPT_DIR/backups/kb}
KEEP=${KB_BACKUP_KEEP:-7}
COMPOSE="docker compose -f $OPT_DIR/docker-compose.yml"
STAMP=$(date '+%Y%m%d-%H%M')
FILE="$BACKUP_DIR/kb-$STAMP.sql.gz"
CRON_LINE="40 3 * * * bash $OPT_DIR/src/scripts/opt/kb-backup.sh >> $BACKUP_DIR/backup.log 2>&1"

case "${1:-}" in
  --dry-run)
    echo "mkdir -p $BACKUP_DIR"
    echo "$COMPOSE exec -T opt-kb-db pg_dump -U aidoor_opt_kb -d ai_door_opt_kb --no-owner | gzip > $FILE"
    echo "ls -1t $BACKUP_DIR/kb-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f   # оставить $KEEP последних"
    echo "cron: $CRON_LINE"
    exit 0 ;;
  --install-cron)
    mkdir -p "$BACKUP_DIR"
    ( crontab -l 2>/dev/null | grep -v 'scripts/opt/kb-backup.sh' ; echo "$CRON_LINE" ) | crontab -
    echo "cron установлен: $CRON_LINE"
    exit 0 ;;
esac

mkdir -p "$BACKUP_DIR"
# pg_dump внутри контейнера: клиент той же версии, что сервер; пароль не нужен (peer-доступ внутри контейнера).
$COMPOSE exec -T opt-kb-db pg_dump -U aidoor_opt_kb -d ai_door_opt_kb --no-owner | gzip > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
SIZE=$(du -h "$FILE" | cut -f1)
# Ротация: только файлы этого скрипта, оставить KEEP последних по времени.
ls -1t "$BACKUP_DIR"/kb-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(date '+%Y-%m-%d %H:%M') бэкап базы знаний: $FILE ($SIZE), копий: $(ls -1 "$BACKUP_DIR"/kb-*.sql.gz | wc -l)"
