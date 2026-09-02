FROM node:lts AS deploy-stage

RUN npm install -g pnpm@10.33.4

WORKDIR /workspace

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/compute-worker/package.json packages/compute-worker/package.json
COPY packages/runtime-config/package.json packages/runtime-config/package.json
COPY packages/tts/package.json packages/tts/package.json
COPY packages/compute-worker packages/compute-worker
COPY packages/runtime-config packages/runtime-config
COPY packages/tts packages/tts

RUN pnpm --config.inject-workspace-packages=true --filter @openreader/compute-worker deploy /opt/compute-worker

FROM node:lts

RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice-writer-nogui && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY --from=deploy-stage /opt/compute-worker ./

ENV COMPUTE_WORKER_HOST=0.0.0.0
ENV PORT=8081

EXPOSE 8081

CMD ["node", "--import", "tsx", "src/server.ts"]
