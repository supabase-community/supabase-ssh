# Supabase SSH

An SSH server that exposes Supabase content as a sandboxed virtual filesystem, designed for AI agents and CLI power-users. Currently serves docs, with plans to expand to more content.

Commands run inside [just-bash](https://github.com/vercel-labs/just-bash) - a sandboxed in-memory shell.

## Local development

From `apps/ssh/`:

**1. Get the docs content:**

```bash
pnpm run setup:docs
```

**2. Generate an SSH host key**:

```bash
pnpm run generate:host-key:local
```

Writes to `keys/host_key`. The `keys/` directory is gitignored.

**3. Start the server:**

```bash
pnpm dev
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
fly ips allocate-v6 --app <app>

# Generate a key and set it as a Fly secret in one step:
fly secrets set SSH_HOST_KEY="$(pnpm run --silent generate:host-key)" --app <app>

# Provision TLS cert for HTTPS (required for the landing page):
fly certs add <domain> --app <app>
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

**Rate limiting (optional):**

Create a Fly Redis (Upstash) database (one per environment, shared across instances):

```bash
fly redis create
# Follow the prompts to name it and select a region
# Outputs the REST URL and token
```

Set the credentials on the SSH app:

```bash
fly secrets set UPSTASH_REDIS_REST_URL="<url>" UPSTASH_REDIS_REST_TOKEN="<token>" --app <app>
```

Without these secrets, rate limiting is silently disabled. Per-instance connection limits still apply.

Optionally tune the limits (e.g. 30 connections/IP per 60s window):

```bash
fly secrets set RATE_LIMIT_MAX=30 RATE_LIMIT_WINDOW_SECONDS=60 --app <app>
```

For local development, `docker compose up -d` starts a Redis + Upstash-compatible REST proxy. Add to `.env.local`:

```
UPSTASH_REDIS_REST_URL=http://localhost:8079
UPSTASH_REDIS_REST_TOKEN=local_token
```

To test with low thresholds:

```
RATE_LIMIT_MAX=3
RATE_LIMIT_WINDOW_SECONDS=10
```

```bash
ssh localhost echo 1 && ssh localhost echo 2 && ssh localhost echo 3 && ssh localhost echo 4
# 4th connection returns: "Too many connections. Retry in Xs."
```
