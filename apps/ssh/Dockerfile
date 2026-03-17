FROM node:22-alpine3.22
RUN corepack enable

WORKDIR /app

# Build context is repo root.
# Run `pnpm run --filter docs build:guides-markdown` before building this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ssh/package.json ./apps/ssh/package.json
RUN pnpm install --frozen-lockfile --filter supabase-ssh

COPY apps/ssh/src/ ./apps/ssh/src/
COPY apps/docs/public/docs ./apps/docs/public/docs

WORKDIR /app/apps/ssh
EXPOSE 22
EXPOSE 9091

CMD ["pnpm", "start"]
