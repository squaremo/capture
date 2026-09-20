# Piper ships prebuilt Linux binaries (glibc) rather than being built
# from source here the way whisper.cpp is (see ../whisper/Dockerfile) —
# it bundles onnxruntime and other native deps that are meaningfully
# harder to cross-compile than whisper.cpp's single CMake target, and
# upstream already publishes arm64 (Pi) + amd64 releases directly. A
# glibc base (not node:22-alpine) is required for the prebuilt binary to
# actually run — its bundled shared libraries assume glibc, not musl.
# Unverified against an actual arm64 (Pi) pull/run yet — see
# synthesize.js and designs/satellite-hardware.md's Open questions; the
# exact release tag/asset names below are worth double-checking against
# https://github.com/rhasspy/piper/releases before a first real build,
# since they weren't fetched live to write this.
FROM node:22-bookworm-slim

ARG PIPER_VERSION=2023.11.14-2
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) PIPER_ARCH=x86_64 ;; \
      arm64) PIPER_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fL -o piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PIPER_ARCH}.tar.gz"; \
    tar -xzf piper.tar.gz; \
    rm piper.tar.gz
ENV PIPER_BIN_PATH=/opt/piper/piper

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# A curated handful of good voices, not just one — parameterize with
# --build-arg PIPER_VOICES="en_GB-alan-medium en_GB-cori-medium ..." to
# change the set without touching this file. Which one actually speaks
# is a *runtime* choice (PIPER_VOICE env var, or a per-request `voice`
# in POST /synthesize's body — see synthesize.js/server.js), not baked
# in at this stage — this just decides what's available to pick from.
# All three defaults are en_GB, matching the app's own dialect; add e.g.
# en_US-lessac-medium here too if a satellite ever wants a choice across
# accents, not just across GB speakers. Full catalogue:
# https://huggingface.co/rhasspy/piper-voices
ARG PIPER_VOICES="en_GB-alan-medium en_GB-cori-medium en_GB-northern_english_male-medium"
RUN mkdir -p /app/models && \
    for voice in ${PIPER_VOICES}; do \
      region=$(echo "$voice" | cut -d- -f1); \
      speaker=$(echo "$voice" | cut -d- -f2); \
      quality=$(echo "$voice" | cut -d- -f3); \
      toplang=${region%%_*}; \
      base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${toplang}/${region}/${speaker}/${quality}"; \
      curl -fL -o "/app/models/${voice}.onnx" "${base}/${voice}.onnx"; \
      curl -fL -o "/app/models/${voice}.onnx.json" "${base}/${voice}.onnx.json"; \
    done
# First entry in the default list — overridable at runtime without a
# rebuild via the PIPER_VOICE env var (see satellite/.env.example and
# ../infra/enable-satellite-tts.sh).
ENV PIPER_VOICE=en_GB-alan-medium

EXPOSE 5002
CMD ["node", "server.js"]
