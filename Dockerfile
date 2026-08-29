FROM node:22-slim AS build

# Install system deps for better-sqlite3 + onnxruntime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libc6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files + postinstall script (needed by npm ci)
COPY package.json package-lock.json* ./
COPY scripts/postinstall.js ./scripts/postinstall.js

# Install deps
RUN npm ci

# Copy sources required by tsup and build in the image. dist/ is git-ignored,
# so it cannot be included in the GitHub Actions checkout context.
COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

# Install system deps for better-sqlite3 + onnxruntime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libc6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY scripts/postinstall.js ./scripts/postinstall.js
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source + dist
COPY --from=build /app/dist/ ./dist/
COPY src/storage/schema.sql ./src/storage/schema.sql
COPY skills/ ./skills/

# Volume for persistent memory
VOLUME ["/data"]

ENV REMEM_DB_PATH=/data/memory.db
ENV NODE_ENV=production

EXPOSE 7331

# Smoke test on startup
CMD ["node", "dist/index.js", "--version"]
