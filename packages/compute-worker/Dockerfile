FROM node:lts AS deploy-stage

RUN npm install -g pnpm@10.33.4

WORKDIR /workspace

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/compute-worker/package.json packages/compute-worker/package.json
COPY packages/compute-worker packages/compute-worker

RUN pnpm --config.inject-workspace-packages=true --filter @openreader/compute-worker deploy /opt/compute-worker

FROM node:lts

WORKDIR /workspace

COPY --from=deploy-stage /opt/compute-worker ./

ENV COMPUTE_WORKER_HOST=0.0.0.0
ENV PORT=8081

EXPOSE 8081

CMD ["node", "--import", "tsx", "src/server.ts"]
