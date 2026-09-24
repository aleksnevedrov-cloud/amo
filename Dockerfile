# Один образ для api и worker; команда задаётся в docker-compose.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/widget/package.json apps/widget/
COPY packages/shared/package.json packages/shared/
COPY packages/amo/package.json packages/amo/
COPY packages/db/package.json packages/db/
COPY packages/catalog/package.json packages/catalog/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/tools/package.json packages/tools/
COPY packages/agent/package.json packages/agent/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @ai-door/api --filter @ai-door/worker run build \
 && pnpm deploy --filter @ai-door/api --prod --legacy /out/api \
 && pnpm deploy --filter @ai-door/worker --prod --legacy /out/worker

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
COPY --from=build /out/api apps/api
COPY --from=build /out/worker apps/worker
COPY packages/db/migrations migrations
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
