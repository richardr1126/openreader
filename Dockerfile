# Stage 1: extract seaweedfs weed binary (for optional embedded weed mini)
# Pin to 4.18 because CI observed upload regressions on 4.19.
FROM chrislusf/seaweedfs:4.18 AS seaweedfs-builder
RUN cp "$(command -v weed)" /tmp/weed && \
    (wget -qO /tmp/SeaweedFS-LICENSE.txt "https://raw.githubusercontent.com/seaweedfs/seaweedfs/master/LICENSE" || \
     wget -qO /tmp/SeaweedFS-LICENSE.txt "https://raw.githubusercontent.com/seaweedfs/seaweedfs/main/LICENSE")


# Stage 2: build the Next.js app
FROM node:lts-alpine AS app-builder

# Install pnpm globally
RUN npm install -g pnpm@11.1.2

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy project files
COPY . .

# Build the Next.js application
RUN pnpm exec next telemetry disable
RUN pnpm build
# Generate third-party dependency license report plus copied license files.
RUN mkdir -p /app/THIRD_PARTY_LICENSES && \
    pnpm dlx license-checker-rseidelsohn@4.3.0 \
      --production \
      --json \
      --relativeLicensePath \
      --out /app/THIRD_PARTY_LICENSES/licenses.json \
      --files /app/THIRD_PARTY_LICENSES/files


# Stage 3: minimal runtime image
FROM node:lts-alpine AS runner

# Add runtime OS dependencies:
# - libreoffice-writer: required for DOCX → PDF conversion
# ffmpeg is provided by ffmpeg-static from node_modules.
RUN apk add --no-cache ca-certificates libreoffice-writer

# drizzle-kit is used by scripts/openreader-entrypoint.mjs for startup migrations.
RUN npm install -g drizzle-kit@0.31.10

# App runtime directory
WORKDIR /app

# Entry-point and migration scripts import dotenv directly.
RUN npm install --no-save dotenv@17.4.2

# Copy standalone Next.js server and required static assets.
COPY --from=app-builder /app/.next/standalone ./
COPY --from=app-builder /app/.next/static ./.next/static
COPY --from=app-builder /app/public ./public
# Copy startup/migration scripts and migration files used by openreader-entrypoint.
COPY --from=app-builder /app/scripts/openreader-entrypoint.mjs ./scripts/openreader-entrypoint.mjs
COPY --from=app-builder /app/scripts/migrate-fs-v2.mjs ./scripts/migrate-fs-v2.mjs
COPY --from=app-builder /app/drizzle/scripts/migrate.mjs ./drizzle/scripts/migrate.mjs
COPY --from=app-builder /app/drizzle/sqlite ./drizzle/sqlite
COPY --from=app-builder /app/drizzle/postgres ./drizzle/postgres
COPY --from=app-builder /app/drizzle.config.sqlite.ts ./drizzle.config.sqlite.ts
COPY --from=app-builder /app/drizzle.config.pg.ts ./drizzle.config.pg.ts
COPY --from=app-builder /app/src/db ./src/db
# Include third-party license report and copied license texts at a stable path in the image.
COPY --from=app-builder /app/THIRD_PARTY_LICENSES /licenses
# Include SeaweedFS license text for the copied weed binary.
COPY --from=seaweedfs-builder /tmp/SeaweedFS-LICENSE.txt /licenses/SeaweedFS-LICENSE.txt
# Include static model notices for runtime-downloaded assets.
COPY --from=app-builder /app/src/lib/server/pdf-layout/model/LICENSE.txt /licenses/pp-doclayoutv3-LICENSE.txt

# Copy seaweedfs weed binary for optional embedded local S3.
COPY --from=seaweedfs-builder /tmp/weed /usr/local/bin/weed
RUN chmod +x /usr/local/bin/weed

# Include OpenAI Whisper license text for runtime-downloaded ONNX artifacts.
COPY --from=app-builder /app/src/lib/server/whisper/model/LICENSE.txt /licenses/openai-whisper-LICENSE.txt

# Expose the port the app runs on
EXPOSE 3003

# Start the application
ENTRYPOINT ["node", "scripts/openreader-entrypoint.mjs", "--"]
CMD ["node", "server.js"]
