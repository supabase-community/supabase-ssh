import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { serve } from '@hono/node-server'

import { app } from './http.js'
import { createSSHServer } from './ssh.js'
import { initTelemetry, shutdownTelemetry } from './telemetry.js'

const PORT = parseInt(process.env.PORT ?? '22', 10)
const METRICS_PORT = parseInt(process.env.METRICS_PORT ?? '9091', 10)
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT ?? '30000', 10)
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT ?? '600000', 10)
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT ?? '10000', 10)
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS ?? '100', 10)
const DRAIN_TIMEOUT = parseInt(process.env.DRAIN_TIMEOUT ?? '15000', 10)

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

  const srv = createSSHServer({
    hostKey,
    port: PORT,
    idleTimeout: IDLE_TIMEOUT,
    sessionTimeout: SESSION_TIMEOUT,
    execTimeout: EXEC_TIMEOUT,
    softLimit: Math.floor(MAX_CONNECTIONS * 0.8),
    hardLimit: MAX_CONNECTIONS,
  })

  await srv.listen()

  const httpServer = serve({ fetch: app.fetch, port: METRICS_PORT }, (info) => {
    console.log(`HTTP server listening on port ${info.port} (/metrics, /healthz)`)
  })

  async function gracefulShutdown(signal: string) {
    console.log(`${signal} received`)
    await Promise.all([
      srv.close('\r\n\r\nQuick update in progress - reconnect in a few seconds!\r\n\r\n', DRAIN_TIMEOUT),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
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
