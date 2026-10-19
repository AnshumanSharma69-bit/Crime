# Build from the repo root:  docker build -f apps/api/Dockerfile -t crimelens-api .
# UNTESTED in the authoring sandbox (no Docker available there).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w @crimelens/api -w @crimelens/shared --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY db db
ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["sh", "-c", "npx tsx apps/api/src/cli.ts && npx tsx apps/api/src/server.ts"]
