import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createSSHServer } from './ssh.js'
import { initTelemetry, shutdownTelemetry } from './telemetry.js'

const PORT = parseInt(process.env.PORT ?? '22', 10)
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS ?? '30000', 10)
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS ?? '100', 10)
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT ?? '10000', 10)

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
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    maxConnections: MAX_CONNECTIONS,
    execTimeout: EXEC_TIMEOUT,
  })

  await srv.listen()

  async function gracefulShutdown(signal: string) {
    console.log(`${signal} received`)
    srv.close('\r\n\r\nQuick update in progress - reconnect in a few seconds!\r\n\r\n')
    await shutdownTelemetry()
    setTimeout(() => process.exit(0), 500)
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
