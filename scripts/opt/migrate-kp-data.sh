#!/usr/bin/env bash
# Этап 4, шаг 7: обёртка над packages/opt/kp/scripts/migrate-from-retail.ts. Запускается в образе сборки ai-door-build
# в docker-сети розницы (postgres доступен по имени), с томами файлов обоих стеков: розничный только для чтения.
# Запуск: bash scripts/opt/migrate-kp-data.sh            # dry-run: показать, что будет перенесено
#         bash scripts/opt/migrate-kp-data.sh --apply    # перенести
set -euo pipefail
RETAIL_DIR=${RETAIL_DIR:-/opt/ai-door/src}
OPT_DIR=${OPT_DIR:-/opt/agent-opt}
ACCOUNT_ID=${ACCOUNT_ID:-28528549}
val() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
net=$(val "$OPT_DIR/.env" RETAIL_NETWORK); net=${net:-src_default}
# Тома compose: <проект>_maildata у розницы, <проект>_opt_data у опта (docker volume ls для проверки).
RETAIL_VOLUME=${RETAIL_VOLUME:-$(basename "$RETAIL_DIR")_maildata}
OPT_VOLUME=${OPT_VOLUME:-$(basename "$OPT_DIR")_opt_data}
docker run --rm --network "$net" \
  -v "$OPT_DIR/src:/app" -w /app \
  -v "$RETAIL_VOLUME:/retail-data:ro" \
  -v "$OPT_VOLUME:/opt-data" \
  -e ACCOUNT_ID="$ACCOUNT_ID" \
  -e SRC_DATABASE_URL="$(val "$RETAIL_DIR/.env" DATABASE_URL)" -e SRC_TOKEN_ENCRYPTION_KEY="$(val "$RETAIL_DIR/.env" TOKEN_ENCRYPTION_KEY)" -e SRC_FILES_ROOT=/retail-data \
  -e DST_DATABASE_URL="$(val "$OPT_DIR/.env" DATABASE_URL)" -e DST_TOKEN_ENCRYPTION_KEY="$(val "$OPT_DIR/.env" TOKEN_ENCRYPTION_KEY)" -e DST_FILES_ROOT=/opt-data \
  ai-door-build sh -c "pnpm install --frozen-lockfile --silent && pnpm exec tsx packages/opt/kp/scripts/migrate-from-retail.ts ${1:-}"
