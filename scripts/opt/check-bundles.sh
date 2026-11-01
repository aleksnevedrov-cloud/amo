#!/usr/bin/env bash
# Этап 4, шаг 3: после сборки образов убедиться, что ни один пакет воркспейса не остался внешним импортом бандла
# (урок инцидента после этапа 1: @ai-door/evals ушёл во external, api не поднялся).
# Запуск: bash scripts/opt/check-bundles.sh [--dry-run]   # после docker compose build в /opt/agent-opt
set -u
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
PATTERN='from "@(core|retail|opt|ai-door)/|require\("@(core|retail|opt|ai-door)/'
fail=0
for pair in "opt-api:apps/opt-api/dist/server.js" "opt-worker:apps/opt-worker/dist/main.js"; do
  image=${pair%%:*}; file=${pair#*:}
  if [ "$DRY" -eq 1 ]; then echo "docker run --rm --entrypoint sh $image -c \"grep -cE '$PATTERN' /app/$file || true\""; continue; fi
  n=$(docker run --rm --entrypoint sh "$image" -c "grep -cE '$PATTERN' /app/$file || true")
  if [ "${n:-0}" = "0" ]; then echo "  OK    $image: внешних пакетов воркспейса в $file нет"; else echo "  FAIL  $image: $n внешних импортов пакетов воркспейса в $file"; fail=1; fi
done
[ "$DRY" -eq 1 ] && echo "(dry-run: команды не выполнялись)"
exit $fail
