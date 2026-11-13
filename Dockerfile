# syntax=docker/dockerfile:1

# MegaTube — Next.js 16 + Prisma 7 + PostgreSQL + FFmpeg
#
# PostgreSQL is external (Northflank managed database). This image contains
# only the application, its production dependencies, and the FFmpeg runtime.
# Database migrations are intentionally a separate deployment step; they
# should not run inside every web container.
#
# The build uses the official Node 22 image. The runtime uses Fedora 42
# because its `ffmpeg-free` package provides both `ffmpeg` and `ffprobe` with
# the `libopenh264` encoder MegaTube requires. Debian/Alpine ffmpeg packages
# do not include that encoder.

ARG NODE_IMAGE=node:22-bookworm
ARG FEDORA_IMAGE=fedora:42

# ---------------------------------------------------------------------------
# Build environment (Node.js 22 + npm).
#
# The full Node image includes the compiler toolchain needed for native
# dependencies such as better-sqlite3 when no prebuilt binary is available.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Build: generate the Prisma 7 client, then build Next.js.
#
# DATABASE_URL is a non-secret placeholder used only so prisma.config.ts can
# load. No database connection is made during the build. Runtime database
# credentials are injected by Northflank and are not baked into this image.
# NEXT_PUBLIC_* values are inlined by Next.js at build time; pass the real
# public Clerk key as a build argument when building a deployable image.
# ---------------------------------------------------------------------------
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG DATABASE_URL="postgresql://build:build@127.0.0.1:5432/megatube?schema=public"
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""

ENV DATABASE_URL=$DATABASE_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${FEDORA_IMAGE} AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/home/app \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFMPEG_PROBE=/usr/bin/ffprobe

RUN dnf install -y --setopt=install_weak_deps=False --setopt=tsflags=nodocs \
      nodejs \
      ffmpeg-free \
      ca-certificates \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libopenh264' \
  && ffprobe -version >/dev/null \
  && useradd --uid 10001 --create-home --shell /bin/false app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/generated ./generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Local caches are regenerable. Mount a persistent volume at /app/data if
# thumbnails/previews/media cache must survive restarts (the volume must be
# writable by the unprivileged `app` user).
RUN mkdir -p /app/data/cache-media /app/data/previews /app/data/thumbs \
  && chown -R app:app /app/data

USER app

EXPOSE 3000
STOPSIGNAL SIGTERM

# Always bind to all interfaces and honour the platform-provided PORT.
CMD ["sh", "-c", "exec ./node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3000}\""]
