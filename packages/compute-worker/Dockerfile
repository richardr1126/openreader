# Fetch the pinned LGPL ffmpeg, verify its SHA-256, and smoke-test it.
FROM node:lts-slim AS ffmpeg-fetch
COPY packaging/ffmpeg /packaging/ffmpeg
RUN node /packaging/ffmpeg/fetch.mjs --out /opt/ffmpeg

FROM node:lts AS deploy-stage

RUN npm install -g pnpm@10.33.4

WORKDIR /workspace

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/compute-worker/package.json packages/compute-worker/package.json
COPY packages/runtime-config/package.json packages/runtime-config/package.json
COPY packages/tts/package.json packages/tts/package.json
RUN pnpm install --frozen-lockfile --filter @openreader/compute-worker...

COPY packages/compute-worker packages/compute-worker
COPY packages/runtime-config packages/runtime-config
COPY packages/tts packages/tts

# Build plain JavaScript (dist/), then deploy only it with production dependencies.
RUN pnpm --filter @openreader/compute-worker build
RUN pnpm --config.inject-workspace-packages=true --filter @openreader/compute-worker deploy --prod /opt/compute-worker

FROM node:lts

RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice-writer-nogui && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY --from=deploy-stage /opt/compute-worker ./
COPY public/web-app-manifest-192x192.png ./public/web-app-manifest-192x192.png
# LGPL ffmpeg with its LICENSE.txt and SOURCE.txt (provenance and corresponding source).
COPY --from=ffmpeg-fetch /opt/ffmpeg /opt/ffmpeg

ENV FFMPEG_BIN=/opt/ffmpeg/ffmpeg

ENV COMPUTE_WORKER_HOST=0.0.0.0
ENV PORT=8081

EXPOSE 8081

CMD ["node", "--enable-source-maps", "dist/server.js"]
