FROM node:24 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY src/ltsm ./dist/ltsm
COPY docs/guide ./docs/guide

ENV PORT=3000
ENV DATA_DIR=/data
ENV BASE_PATH=/
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD BASE_PATH="${BASE_PATH%/}"; wget -qO- "http://localhost:${PORT}${BASE_PATH}/healthz" || exit 1

USER node
CMD ["node", "dist/index.js"]
