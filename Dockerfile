# Build: docker build -t openclaw-command-center .
# Run:   see deploy/docker/compose.yaml
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The server has no npm dependencies: Node runs its TypeScript directly.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    CC_DATA_DIR=/data \
    CC_STATIC_DIR=/app/dist/web/browser
COPY package.json ./
COPY shared ./shared
COPY server/src ./server/src
COPY --from=build /app/dist/web ./dist/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 18821
CMD ["node", "server/src/main.ts"]
