#!/bin/sh
# Точка входа контейнеров опта (RFD-AI-AGENT-OPT-KP-DOWNLOAD, дефект 2б): тома /data и /kb-files могли быть
# созданы или заполнены от root (миграция, копирование файлов) — процесс node тогда не может создать
# /data/kp/<аккаунт>/<сделка>/ (EACCES). Перед запуском владелец томов выравнивается на node, затем права
# сбрасываются (su-exec). Проверка только по владельцу корня тома: chown -R не гоняется при каждом старте зря.
set -e
NODE_UID="$(id -u node)"
for d in /data /kb-files; do
  if [ -d "$d" ] && [ "$(stat -c %u "$d")" != "$NODE_UID" ]; then
    echo "entrypoint: $d принадлежит uid $(stat -c %u "$d"), выравниваю владельца на node" >&2
    chown -R node:node "$d" || echo "entrypoint: chown $d не удался — проверьте права на том" >&2
  fi
done
exec su-exec node "$@"
