# Один образ для процессов api и connectors; команда задаётся в docker-compose.yml.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/
COPY widget/package.json widget/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @rf-messenger/server run build \
 && pnpm deploy --filter @rf-messenger/server --prod --legacy /out/server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
COPY --from=build /out/server/node_modules node_modules
COPY --from=build /out/server/package.json package.json
COPY --from=build /app/server/dist dist
COPY server/migrations migrations
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3100
CMD ["node", "dist/api.js"]
