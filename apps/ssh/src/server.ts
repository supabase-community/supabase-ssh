import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { serve } from '@hono/node-server'

import { createApiServer } from './api.js'
import { CommandCache } from './command-cache.js'
import { createMetricsServer } from './metrics.js'
import { createRateLimiter } from './ratelimit.js'
import { createSSHServer } from './ssh.js'
import { initTelemetry, shutdownTelemetry } from './telemetry.js'

const PORT = parseInt(process.env.PORT ?? '22', 10)
const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? '9091', 10)
const API_PORT = parseInt(process.env.API_PORT ?? '8080', 10)
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT ?? '60000', 10)
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT ?? '600000', 10)
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT ?? '10000', 10)
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS ?? '100', 10)
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP ?? '10', 10)
const DRAIN_TIMEOUT = parseInt(process.env.DRAIN_TIMEOUT ?? '15000', 10)
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? '*'

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '30', 10)
const RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS ?? '60', 10)

const COMMAND_CACHE = process.env.COMMAND_CACHE !== 'false'
const COMMAND_CACHE_MAX_ENTRIES = parseInt(process.env.COMMAND_CACHE_MAX_ENTRIES ?? '1000', 10)
const COMMAND_CACHE_MAX_OUTPUT_BYTES = parseInt(
  process.env.COMMAND_CACHE_MAX_OUTPUT_BYTES ?? String(512 * 1024),
  10,
)

const WEB_DIR = process.env.WEB_DIR
const ENABLE_EXEC_API = process.env.ENABLE_EXEC_API === 'true'

const SSH_HOST_KEY_PATH = resolve(process.env.SSH_HOST_KEY_PATH ?? './ssh_host_key')

async function loadHostKey(): Promise<Buffer> {
  if (process.env.SSH_HOST_KEY) {
    const pem = process.env.SSH_HOST_KEY
    const fingerprint = createHash('sha256').update(pem).digest('base64')
    console.log(`Loaded host key from SSH_HOST_KEY env var (SHA256:${fingerprint})`)
    return Buffer.from(pem)
  }

  const pem = await readFile(SSH_HOST_KEY_PATH)
  const fingerprint = createHash('sha256').update(pem).digest('base64')
  console.log(`Loaded host key from ${SSH_HOST_KEY_PATH} (SHA256:${fingerprint})`)
  return pem
}

async function main() {
  initTelemetry()
  const hostKey = await loadHostKey()

  const rateLimiter =
    UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN
      ? createRateLimiter({
          url: UPSTASH_REDIS_REST_URL,
          token: UPSTASH_REDIS_REST_TOKEN,
          maxRequests: RATE_LIMIT_MAX,
          windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        })
      : undefined

  if (rateLimiter) {
    console.log(
      `Rate limiting enabled (${RATE_LIMIT_MAX} connections/${RATE_LIMIT_WINDOW_SECONDS}s per IP)`,
    )
  } else {
    console.log('Rate limiting disabled (no UPSTASH_REDIS_REST_URL configured)')
  }

  const commandCache = COMMAND_CACHE
    ? new CommandCache({
        maxEntries: COMMAND_CACHE_MAX_ENTRIES,
        maxOutputBytes: COMMAND_CACHE_MAX_OUTPUT_BYTES,
      })
    : null

  const srv = createSSHServer({
    hostKey,
    port: PORT,
    idleTimeout: IDLE_TIMEOUT,
    sessionTimeout: SESSION_TIMEOUT,
    execTimeout: EXEC_TIMEOUT,
    softLimit: Math.floor(MAX_CONNECTIONS * 0.8),
    hardLimit: MAX_CONNECTIONS,
    maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP,
    rateLimiter,
    commandCache: commandCache ?? false,
  })

  await srv.listen()

  const metricsApp = createMetricsServer({
    getActiveConnections: () => srv.activeConnectionCount,
  })

  const httpServer = serve({ fetch: metricsApp.fetch, port: METRICS_PORT }, (info) => {
    console.log(`HTTP server listening on port ${info.port} (/metrics, /healthz)`)
  })

  const apiApp = createApiServer({
    enableExec: ENABLE_EXEC_API,
    execTimeout: EXEC_TIMEOUT,
    commandCache,
    rateLimiter,
    allowedOrigin: WEB_ORIGIN,
    webDir: WEB_DIR,
  })

  const apiServer = serve({ fetch: apiApp.fetch, port: API_PORT }, (info) => {
    console.log(`API server listening on port ${info.port} (/api/exec)`)
    if (WEB_DIR) {
      console.log(`Serving static files from ${WEB_DIR}`)
    }
  })

  async function gracefulShutdown(signal: string) {
    console.log(`${signal} received`)
    await Promise.all([
      srv.close(
        '\r\n\r\nQuick update in progress - reconnect in a few seconds!\r\n\r\n',
        DRAIN_TIMEOUT,
      ),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      new Promise<void>((resolve) => apiServer.close(() => resolve())),
      shutdownTelemetry(),
    ])
    process.exit(0)
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
