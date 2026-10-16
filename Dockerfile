# ---- 构建阶段：编译 web 与 server ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/games/core/package.json packages/games/core/
COPY packages/games/night-of-ninja/package.json packages/games/night-of-ninja/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @dg/web build && pnpm --filter @dg/server build

# ---- 运行阶段：仅产物 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DG_PORT=8787

COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/node_modules ./node_modules

EXPOSE 8787
CMD ["node", "apps/server/dist/server.cjs"]
