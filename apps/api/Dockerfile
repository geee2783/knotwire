# Knotwire - GNU AGPL-3.0-only. See LICENSE in the repository root.
FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/api ./apps/api
RUN npm ci && npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/package.json ./package.json
EXPOSE 8080
USER node
CMD ["node", "apps/api/dist/server.js"]
