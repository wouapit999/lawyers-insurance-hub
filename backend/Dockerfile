# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Lawyers Insurance Hub — API image
#
# Multi-stage: the build stage carries the full toolchain and dev
# dependencies; the runtime stage carries neither. The published image holds
# compiled JavaScript, production node_modules and the generated Prisma
# client, and runs as a non-root user.
# ---------------------------------------------------------------------------

# --- deps ------------------------------------------------------------------
FROM node:26-alpine AS deps
WORKDIR /app

# Argon2 compiles a native addon, so the build stage needs a toolchain. It is
# absent from the runtime stage, which is one of the main reasons to split.
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json package-lock.json* ./
COPY packages/domain/package.json ./packages/domain/
COPY backend/package.json ./backend/
RUN npm ci --workspaces --include-workspace-root

# --- build -----------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY . .

RUN npm run build --workspace @lih/domain \
 && npx prisma generate --schema backend/prisma/schema.prisma \
 && npm run build --workspace @lih/api

# Drop dev dependencies before they are copied into the runtime image.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# --- runtime ---------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# OpenSSL is required by the Prisma query engine; dumb-init gives us correct
# signal forwarding so Kubernetes can terminate the pod gracefully.
RUN apk add --no-cache openssl dumb-init \
 && addgroup -S lih && adduser -S lih -G lih

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--enable-source-maps"

COPY --from=build --chown=lih:lih /app/node_modules ./node_modules
COPY --from=build --chown=lih:lih /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=lih:lih /app/packages/domain/package.json ./packages/domain/
COPY --from=build --chown=lih:lih /app/backend/dist ./dist
COPY --from=build --chown=lih:lih /app/backend/prisma ./prisma
COPY --from=build --chown=lih:lih /app/backend/package.json ./

USER lih
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
