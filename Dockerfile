# Один образ для api и worker; команда задаётся в docker-compose.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/widget/package.json apps/widget/
COPY packages/core/shared/package.json packages/core/shared/
COPY packages/core/amo/package.json packages/core/amo/
COPY packages/core/db/package.json packages/core/db/
COPY packages/core/llm/package.json packages/core/llm/
COPY packages/retail/catalog/package.json packages/retail/catalog/
COPY packages/retail/knowledge/package.json packages/retail/knowledge/
COPY packages/core/tools/package.json packages/core/tools/
COPY packages/retail/agent/package.json packages/retail/agent/
COPY packages/retail/pricing/package.json packages/retail/pricing/
COPY packages/core/media/package.json packages/core/media/
COPY packages/core/docs/package.json packages/core/docs/
COPY packages/retail/mail/package.json packages/retail/mail/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @ai-door/api --filter @ai-door/worker run build \
 && pnpm deploy --filter @ai-door/api --prod --legacy /out/api \
 && pnpm deploy --filter @ai-door/worker --prod --legacy /out/worker

FROM node:22-alpine
WORKDIR /app
# LibreDWG — конвертация чертежей DWG → DXF (фаза 4). Если пакета нет в репозитории — разбор DWG отключится с понятной ошибкой.
RUN apk add --no-cache libredwg || true
# Сборка КП: DOCX -> PDF через LibreOffice (тема RFD-AI-AGENT-KP, этап 4).
RUN apk add --no-cache libreoffice-writer ttf-dejavu font-noto || true
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
COPY --from=build /out/api apps/api
COPY --from=build /out/worker apps/worker
COPY packages/core/db/migrations migrations
# Хранилище вложений писем: том монтируется сюда, владелец — пользователь приложения.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
