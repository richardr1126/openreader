FROM node:lts AS deploy-stage

RUN npm install -g pnpm@11.1.2

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY compute/worker/package.json compute/worker/package.json
COPY compute/core/package.json compute/core/package.json

COPY compute/worker compute/worker
COPY compute/core compute/core

RUN pnpm --config.inject-workspace-packages=true --filter @openreader/compute-worker deploy /opt/compute-worker

FROM node:lts

RUN npm install -g pnpm@11.1.2

WORKDIR /workspace

COPY --from=deploy-stage /opt/compute-worker ./

ENV COMPUTE_WORKER_HOST=0.0.0.0
ENV PORT=8081

EXPOSE 8081

CMD ["node", "--import", "tsx", "src/server.ts"]
