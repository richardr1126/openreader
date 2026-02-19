# Stage 1: build whisper.cpp (no model download – the app handles that)
FROM alpine:3.23 AS whisper-builder

RUN apk add --no-cache git cmake build-base

WORKDIR /opt

ARG TARGETARCH

RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git && \
    cd whisper.cpp && \
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF $( [ "$TARGETARCH" = "arm64" ] && echo "-DGGML_CPU_ARM_ARCH=armv8-a" || true ) && \
    cmake --build build -j

# Stage 1b: extract seaweedfs weed binary (for optional embedded weed mini)
FROM chrislusf/seaweedfs:latest AS seaweedfs-builder
RUN cp "$(command -v weed)" /tmp/weed


# Stage 2: build the Next.js app
FROM node:lts-alpine AS app-builder

# Install pnpm globally
RUN npm install -g pnpm

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy project files
COPY . .

# Build the Next.js application
RUN pnpm exec next telemetry disable
RUN pnpm build


# Stage 3: minimal runtime image
FROM node:lts-alpine AS runner

# Add runtime OS dependencies:
# - libreoffice-writer: required for DOCX → PDF conversion
# ffmpeg is provided by ffmpeg-static from node_modules.
RUN apk add --no-cache ca-certificates libreoffice-writer

# Install pnpm globally for running the app
RUN npm install -g pnpm

# App runtime directory
WORKDIR /app

# Copy built app and dependencies from the builder stage
COPY --from=app-builder /app ./

# Copy the compiled whisper.cpp build output into the runtime image
# (includes whisper-cli and its shared libraries, e.g. libwhisper.so, libggml.so)
COPY --from=whisper-builder /opt/whisper.cpp/build /opt/whisper.cpp/build
# Copy seaweedfs weed binary for optional embedded local S3.
COPY --from=seaweedfs-builder /tmp/weed /usr/local/bin/weed
RUN chmod +x /usr/local/bin/weed

# Point the app at the compiled whisper-cli binary and ensure its libs are discoverable
ENV WHISPER_CPP_BIN=/opt/whisper.cpp/build/bin/whisper-cli
ENV LD_LIBRARY_PATH=/opt/whisper.cpp/build

# Expose the port the app runs on
EXPOSE 3003

# Start the application
ENTRYPOINT ["node", "scripts/openreader-entrypoint.mjs", "--"]
CMD ["pnpm", "start:raw"]
