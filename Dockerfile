# Stage 1: extract seaweedfs weed binary (for optional embedded weed mini)
# Pin to 4.18 because CI observed upload regressions on 4.19.
FROM chrislusf/seaweedfs:4.18 AS seaweedfs-builder
RUN cp "$(command -v weed)" /tmp/weed && \
    (wget -qO /tmp/SeaweedFS-LICENSE.txt "https://raw.githubusercontent.com/seaweedfs/seaweedfs/master/LICENSE" || \
     wget -qO /tmp/SeaweedFS-LICENSE.txt "https://raw.githubusercontent.com/seaweedfs/seaweedfs/main/LICENSE")

# Stage 1b: extract nats-server binary for embedded single-container worker mode.
FROM nats:2.11-alpine AS nats-builder
RUN cp "$(command -v nats-server)" /tmp/nats-server


# Stage 2: build the Next.js app
FROM node:lts-alpine AS app-builder

# Install pnpm globally
RUN npm install -g pnpm@11.1.2

# Create app directory
WORKDIR /app

# Copy workspace manifests needed for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY compute/core/package.json ./compute/core/package.json
COPY compute/worker/package.json ./compute/worker/package.json

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

# Install pnpm for runtime process commands.
RUN npm install -g pnpm@10.33.4

# App runtime directory
WORKDIR /app

# Copy built app and runtime files from the builder stage (non-standalone runtime).
COPY --from=app-builder /app ./
# Include third-party license report and copied license texts at a stable path in the image.
COPY --from=app-builder /app/THIRD_PARTY_LICENSES /licenses
# Include SeaweedFS license text for the copied weed binary.
COPY --from=seaweedfs-builder /tmp/SeaweedFS-LICENSE.txt /licenses/SeaweedFS-LICENSE.txt
# Include static model notices for runtime-downloaded assets.
COPY --from=app-builder /app/compute/core/src/pdf/assets/LICENSE.txt /licenses/pp-doclayoutv3-LICENSE.txt

# Copy seaweedfs weed binary for optional embedded local S3.
COPY --from=seaweedfs-builder /tmp/weed /usr/local/bin/weed
RUN chmod +x /usr/local/bin/weed
# Copy nats-server binary for embedded local JetStream.
COPY --from=nats-builder /tmp/nats-server /usr/local/bin/nats-server
RUN chmod +x /usr/local/bin/nats-server

# Include OpenAI Whisper license text for runtime-downloaded ONNX artifacts.
COPY --from=app-builder /app/compute/core/src/whisper/assets/LICENSE.txt /licenses/openai-whisper-LICENSE.txt

# Expose the port the app runs on
EXPOSE 3003

# Start the application
ENTRYPOINT ["node", "scripts/openreader-entrypoint.mjs", "--"]
CMD ["pnpm", "start:raw"]
