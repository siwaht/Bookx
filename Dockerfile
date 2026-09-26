# syntax=docker/dockerfile:1

# The Bookx app server, run by Cloudflare Containers behind the Bookx Worker.
#
# The server is bundled on the host first (`pnpm run build:cloudflare`, which
# `wrangler dev` and `wrangler deploy` run automatically) into dist/container/.
# Only ffmpeg is fetched here, so the Linux binary is right whatever machine
# builds the image.

FROM node:24.13.0-bookworm-slim AS ffmpeg
WORKDIR /ffmpeg
# The static Linux build pinned by ffmpeg-static 5.3.0 (ffmpeg 7.0.2).
RUN npm install --no-save --no-audit --no-fund ffmpeg-static@5.3.0 \
 && ./node_modules/ffmpeg-static/ffmpeg -hide_banner -version | head -n 1

FROM node:24.13.0-bookworm-slim
ENV NODE_ENV=production \
    BOOKX_CONTAINER=1 \
    PORT=8080 \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    BOOKX_MIGRATIONS_DIR=/app/drizzle/sqlite
WORKDIR /app
COPY --from=ffmpeg /ffmpeg/node_modules/ffmpeg-static/ffmpeg /usr/local/bin/ffmpeg
COPY dist/container/ ./
COPY drizzle/sqlite/ ./drizzle/sqlite/
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "index.mjs"]
