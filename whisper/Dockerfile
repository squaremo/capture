# ── whisper.cpp build stage ───────────────────────────────────────────
# Builds the CLI binary from source rather than fetching a prebuilt
# release — whisper.cpp doesn't publish arm64 binaries for a plain Alpine
# base, and this image cross-builds for linux/arm64 via Buildx + QEMU
# (see .github/workflows/build-whisper.yml, mirroring build-satellite.yml),
# so building from source here gets the right architecture for free
# rather than needing a second per-arch download step. Unverified against
# an actual arm64 (Pi) build yet — see transcribe.js and designs/
# satellite-hardware.md's Open questions; flag this stage first if the
# image ever fails to build for linux/arm64.
FROM node:22-alpine AS whisper-builder
RUN apk add --no-cache git build-base cmake curl
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
 && cmake --build build --config Release --target whisper-cli -j"$(nproc)"
# `tiny.en` — see the RAM/CPU discussion in designs/satellite-hardware.md:
# base is roughly 2x tiny's footprint on a Pi 4 2GB that's already running
# a Chromium kiosk. Fetched directly from the model's Hugging Face URL
# rather than the repo's own download-ggml-model.sh, which needs bash
# (not on Alpine by default) for no benefit here — same URL that script
# hits.
RUN mkdir -p /build/models && \
    curl -fL -o /build/models/ggml-tiny.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin

# ── Runtime image ──────────────────────────────────────────────────────
FROM node:22-alpine

# ffmpeg: transcodes the browser's webm/opus recording into the 16kHz
# mono WAV whisper.cpp's CLI expects — see transcribe.js.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

COPY --from=whisper-builder /build/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /build/models/ggml-tiny.en.bin /app/models/ggml-tiny.en.bin
ENV WHISPER_BIN_PATH=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL_PATH=/app/models/ggml-tiny.en.bin

EXPOSE 5001
CMD ["node", "server.js"]
