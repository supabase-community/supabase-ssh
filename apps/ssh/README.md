# Supabase SSH

An SSH server that exposes Supabase content as a sandboxed virtual filesystem, designed for AI agents and CLI power-users. Currently serves docs, with plans to expand to more content.

Commands run inside [just-bash](https://github.com/vercel-labs/just-bash) - a sandboxed in-memory shell.

## Local development

**1. Build the docs** (from repo root):

```bash
pnpm run --filter docs build:guides-markdown
```

Outputs to `apps/docs/public/docs/guides/`. The Docker image copies this directory directly.

**2. Generate a host key** (from `apps/ssh/`):

```bash
pnpm run generate:host-key:local
```

Writes to `keys/host_key`. The `keys/` directory is gitignored.

**3. Start the server:**

```bash
docker compose up
```

The server listens on port 22.

## Usage

Run a single command:

```bash
ssh localhost "cat /docs/getting-started/quickstarts/nextjs.md"
```

Pipe and combine commands:

```bash
ssh localhost "grep -rl 'storage' /docs | head -10"
```

Interactive shell:

```bash
ssh localhost
```

## Deploying to Fly

Port 22 requires a dedicated IPv4 per app (~$2/mo). Repeat these steps for each environment.

**First-time setup:**

```bash
fly apps create <app> --org <org>
fly ips allocate-v4 --app <app>

# Generate a key and set it as a Fly secret in one step:
fly secrets set SSH_HOST_KEY="$(pnpm run --silent generate:host-key)" --app <app>
```

The host key is the only durable state. You can recover it from a running machine:

```bash
fly ssh console -C "printenv SSH_HOST_KEY" --app <app>
```

**Telemetry (optional):**

```bash
fly secrets set LOGFLARE_SOURCE="<source-uuid>" LOGFLARE_API_KEY="<api-key>" --app <app>
```

Exports OTel spans to Logflare via OTLP protobuf. Without these secrets, telemetry is silently disabled.

**Deploy:**

```bash
pnpm deploy:staging  # supabase-ssh-staging
pnpm deploy:prod     # supabase-ssh
```

Both scripts run `build:guides-markdown` automatically before deploying.

## Simulating a deployed environment

To use `docs.supabase.com` as the hostname locally, add this to `/etc/hosts`:

```
127.0.0.1 docs.supabase.com
```

Then connect normally:

```bash
ssh docs.supabase.com "grep -r 'auth' /docs/auth/"
```

Remove the entry when done.

## Demo

The `demo/` folder contains an `AGENTS.md` system prompt (`CLAUDE.md` symlinked) demonstrating how an agent might access the docs via this server.

## Aliases

| Alias | Expands to |
| ----- | ---------- |
| `ll`  | `ls -alF`  |
| `la`  | `ls -a`    |
| `l`   | `ls -CF`   |
