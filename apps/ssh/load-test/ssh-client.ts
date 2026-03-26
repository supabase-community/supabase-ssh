import { Client } from 'ssh2'

export interface ConnectionOptions {
  host: string
  port: number
  /** Connection timeout in ms (default 5000) */
  timeout?: number
}

export interface TimedResult {
  stdout: string
  stderr: string
  exitCode: number
  /** Time from connect() to 'ready' event (ms) */
  connectTimeMs: number
  /** Time from exec() to channel close (ms) */
  commandTimeMs: number
  /** True if connection was rejected before auth */
  rejected: boolean
  rejectionType?: 'capacity' | 'rate_limit' | 'concurrency'
}

export interface ConnectedClient {
  client: Client
  connectTimeMs: number
  rejected: boolean
  rejectionType?: TimedResult['rejectionType']
  /** stderr received during connection (rejection messages) */
  rejectionMessage?: string
}

/** Connect to the SSH server. Returns the client + timing info. */
export function connect(opts: ConnectionOptions): Promise<ConnectedClient> {
  const { host, port, timeout = 5000 } = opts
  return new Promise((resolve, reject) => {
    const client = new Client()
    const start = performance.now()
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        client.destroy()
        reject(new Error(`Connection timeout after ${timeout}ms`))
      }
    }, timeout)

    client
      .on('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          client,
          connectTimeMs: performance.now() - start,
          rejected: false,
        })
      })
      .on('banner', (message: string) => {
        // Rejection messages come as banners before auth
        if (settled) return
        const result = parseRejection(message)
        if (result) {
          settled = true
          clearTimeout(timer)
          client.end()
          resolve({
            client,
            connectTimeMs: performance.now() - start,
            rejected: true,
            rejectionType: result.type,
            rejectionMessage: message.trim(),
          })
        }
      })
      .on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      .connect({ host, port, username: 'loadtest', password: 'ignored' })
  })
}

/** Execute a command on a connected client. Returns stdout, stderr, exit code, and timing. */
export function exec(
  client: Client,
  command: string,
  timeout = 30_000,
): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  commandTimeMs: number
  timedOut: boolean
}> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({
          stdout: '',
          stderr: '',
          exitCode: -1,
          commandTimeMs: performance.now() - start,
          timedOut: true,
        })
      }
    }, timeout)

    client.exec(command, (err, stream) => {
      if (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      stream.on('close', (code: number) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({
            stdout,
            stderr,
            exitCode: code,
            commandTimeMs: performance.now() - start,
            timedOut: false,
          })
        }
      })
    })
  })
}

function parseRejection(message: string): { type: TimedResult['rejectionType'] } | null {
  if (message.includes('Server is at capacity')) return { type: 'capacity' }
  if (message.includes('Too many connections')) return { type: 'rate_limit' }
  if (message.includes('Too many concurrent connections')) return { type: 'concurrency' }
  return null
}
