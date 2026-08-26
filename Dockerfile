FROM node:22-slim

# Install system deps for better-sqlite3 + onnxruntime
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libc6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files + postinstall script (needed by npm ci)
COPY package.json package-lock.json* ./
COPY scripts/postinstall.js ./scripts/postinstall.js

# Install deps
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source + dist
COPY dist/ ./dist/
COPY src/storage/schema.sql ./src/storage/schema.sql
COPY skills/ ./skills/

# Volume for persistent memory
VOLUME ["/data"]

ENV REMEM_DB_PATH=/data/memory.db
ENV NODE_ENV=production

EXPOSE 7331

# Smoke test on startup
CMD ["node", "dist/index.js", "version"]
