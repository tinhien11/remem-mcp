FROM node:22-slim

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, sqlite-vec)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including dev for build)
RUN npm ci || npm install

# Copy source and build
COPY . .
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev

# Remove build dependencies to keep image small
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

# Default data directory
ENV TDAI_DB_PATH=/data/memory.db
ENV TDAI_AUDIT_LOG_PATH=/data/audit.jsonl
VOLUME /data

# Expose viewer port
EXPOSE 7331

# Default command: start MCP server
ENTRYPOINT ["node", "dist/index.js"]
