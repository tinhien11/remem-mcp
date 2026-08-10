FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source and build
COPY . .
RUN npm run build

# Default data directory
ENV TDAI_DB_PATH=/data/memory.db
ENV TDAI_AUDIT_LOG_PATH=/data/audit.jsonl
VOLUME /data

# Expose viewer port
EXPOSE 7331

# Default command: start MCP server
ENTRYPOINT ["node", "dist/index.js"]
