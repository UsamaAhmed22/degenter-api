# Dockerfile for NestJS API
FROM node:18-bullseye

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Install tini for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Legacy entrypoint shim for Compose expecting api/server.js
RUN printf "require('../dist/api/main.js');\n" > /app/api/server.js

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/api/main.js"]
