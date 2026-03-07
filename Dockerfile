FROM node:20-slim AS base
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --ignore-scripts

# Build client
FROM deps AS build-client
COPY client/ client/
RUN npm run build --workspace=client

# Build server
FROM deps AS build-server
COPY server/ server/
RUN npm run build --workspace=server

# Production image
FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=build-server /app/server/dist ./server/dist
COPY --from=build-server /app/server/package.json ./server/
COPY --from=build-client /app/client/dist ./client/dist
COPY package.json ./

RUN mkdir -p /app/data/audio /app/data/renders /app/data/exports /app/data/uploads /app/data/backups

EXPOSE 3001
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
