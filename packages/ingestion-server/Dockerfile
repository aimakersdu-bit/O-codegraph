FROM node:22-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package*.json tsconfig.json ./

# Copy packages
COPY packages/shared/package*.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/ingestion-server/package*.json packages/ingestion-server/tsconfig.json ./packages/ingestion-server/

# Copy the root package's code (since shared and ingestion-server depend on it)
COPY src ./src
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code of packages
COPY packages/shared/src ./packages/shared/src
COPY packages/ingestion-server/src ./packages/ingestion-server/src

# Build packages in order: root, then shared, then ingestion-server
RUN npm run build
RUN npm run build -w packages/shared
RUN npm run build -w packages/ingestion-server

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy built code and production node_modules from builder
COPY --from=builder /app /app

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start", "-w", "packages/ingestion-server"]
