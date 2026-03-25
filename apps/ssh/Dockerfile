FROM node:22-alpine3.22 AS builder
RUN corepack enable

# Native build tools for ssh2's C++ crypto binding (AES-GCM, ChaCha20, DH)
RUN apk add --no-cache python3 make g++ && npm install -g node-gyp

WORKDIR /app

# Build context is repo root.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ssh/package.json apps/ssh/tsconfig.json ./apps/ssh/
RUN pnpm install --frozen-lockfile --filter supabase-ssh

# pnpm 10 skips install scripts unless allowlisted via onlyBuiltDependencies.
# ssh2's install.js runs node-gyp to compile its native crypto binding.
RUN cd node_modules/.pnpm/ssh2@*/node_modules/ssh2 && node install.js

COPY apps/ssh/src/ ./apps/ssh/src/
RUN pnpm --filter supabase-ssh run build

FROM node:22-alpine3.22
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/ssh/node_modules ./apps/ssh/node_modules
COPY --from=builder /app/apps/ssh/dist ./apps/ssh/dist
COPY --from=builder /app/apps/ssh/package.json ./apps/ssh/package.json

# Docs content - fetched by CI before docker build
COPY docs ./docs

WORKDIR /app/apps/ssh
EXPOSE 22
EXPOSE 9091

CMD ["node", "dist/server.js"]
