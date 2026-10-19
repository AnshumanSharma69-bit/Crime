# Build from the repo root:  docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.org -t crimelens-web .
# NEXT_PUBLIC_* values are baked in at build time. UNTESTED in the authoring sandbox (no Docker available there).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w @crimelens/web -w @crimelens/shared --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY design design
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_MAP_STYLE_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @crimelens/web
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@crimelens/web"]
