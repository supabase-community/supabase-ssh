import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createMetricsServer } from './metrics.js'
import type { RateLimiter } from './ratelimit.js'
import { createSSHServer } from './ssh.js'

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}) as string

const docsDir = mkdtempSync(join(tmpdir(), 'ssh-test-docs-'))

let port: number
let srv: ReturnType<typeof createSSHServer>
let metricsApp: ReturnType<typeof createMetricsServer>
const clients: Client[] = []

beforeAll(async () => {
  srv = createSSHServer({
    hostKey: Buffer.from(hostKey),
    port: 0,
    idleTimeout: 3000,
    softLimit: 5,
    hardLimit: 10,
    execTimeout: 5000,
    docsDir,
  })
  metricsApp = createMetricsServer({
    getActiveConnections: () => srv.activeConnectionCount,
  })
  port = await srv.listen()
})

afterEach(() => {
  for (const c of clients) {
    c.end()
    c.destroy()
  }
  clients.length = 0
})

afterAll(async () => {
  await srv.close()
})

function connectClient(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    clients.push(client)
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'test', password: 'ignored' })
  })
}

/** Connect and handle auth-phase rejection via USERAUTH_BANNER + disconnect. */
function connectWithBanner(
  p: number,
): Promise<{ client: Client; rejected: boolean; banner?: string }> {
  return new Promise((resolve) => {
    const client = new Client()
    clients.push(client)
    let bannerText = ''
    client
      .on('banner', (msg: string) => {
        bannerText += msg
      })
      .on('ready', () => resolve({ client, rejected: false }))
      .on('close', () => {
        // Server sends banner then disconnects for rejected clients
        if (bannerText) resolve({ client, rejected: true, banner: bannerText })
      })
      .on('error', () => {
        // Also handle error-based rejection (e.g. auth failure)
        if (bannerText) resolve({ client, rejected: true, banner: bannerText })
      })
      .connect({ host: '127.0.0.1', port: p, username: 'test', password: 'ignored' })
  })
}

function execCommand(
  client: Client,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      stream.on('close', (code: number) => resolve({ stdout, stderr, code }))
    })
  })
}

// ---------------------------------------------------------------------------
// SSH smoke tests
// ---------------------------------------------------------------------------
describe('SSH Server', () => {
  describe('exec mode', () => {
    it('returns stdout and exit code 0', async () => {
      const client = await connectClient()
      const { stdout, code } = await execCommand(client, 'echo hello')
      expect(stdout).toBe('hello\n')
      expect(code).toBe(0)
    })

    it('propagates non-zero exit code', async () => {
      const client = await connectClient()
      const { code } = await execCommand(client, 'exit 42')
      expect(code).toBe(42)
    })

    it('returns stderr', async () => {
      const client = await connectClient()
      const { stderr, code } = await execCommand(client, 'echo err >&2')
      expect(stderr).toBe('err\n')
      expect(code).toBe(0)
    })

    it('agents command outputs markdown', async () => {
      const client = await connectClient()
      const { stdout, code } = await execCommand(client, 'agents')
      expect(code).toBe(0)
      expect(stdout).toContain('## Supabase Docs')
      expect(stdout).toContain('ssh supabase.sh')
    })
  })

  describe('shell mode', () => {
    it('sends command and receives output', async () => {
      const client = await connectClient()
      const output = await new Promise<string>((resolve, reject) => {
        client.shell((err, stream) => {
          if (err) return reject(err)
          let buf = ''
          stream.on('data', (data: Buffer) => {
            buf += data.toString()
            // Wait for command output then the next prompt
            if (buf.includes('hello') && buf.indexOf('$ ', buf.indexOf('hello')) !== -1) {
              stream.end('exit\n')
              resolve(buf)
            }
          })
          // Wait for initial prompt, then send command
          const waitForPrompt = () => {
            if (buf.includes('$ ')) {
              stream.write('echo hello\n')
            } else {
              setTimeout(waitForPrompt, 50)
            }
          }
          waitForPrompt()
        })
      })
      expect(output).toContain('hello')
    })

    it('closes channel on exit command', async () => {
      const client = await connectClient()
      const output = await new Promise<string>((resolve, reject) => {
        client.shell((err, stream) => {
          if (err) return reject(err)
          let buf = ''
          stream.on('data', (data: Buffer) => {
            buf += data.toString()
          })
          stream.on('close', () => resolve(buf))
          const waitForPrompt = () => {
            if (buf.includes('$ ')) {
              stream.write('exit\n')
            } else {
              setTimeout(waitForPrompt, 50)
            }
          }
          waitForPrompt()
        })
      })
      expect(output).toContain('Thanks for stopping by')
    })
  })

  describe('connection management', () => {
    it('rejects connections at hard limit', async () => {
      const limitSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        softLimit: 3,
        hardLimit: 3,
        execTimeout: 5000,
        docsDir,
      })
      const limitPort = await limitSrv.listen()

      const r1 = await connectWithBanner(limitPort)
      const r2 = await connectWithBanner(limitPort)
      expect(r1.rejected).toBe(false)
      expect(r2.rejected).toBe(false)

      // Third connection should be rejected at auth with capacity banner
      const r3 = await connectWithBanner(limitPort)
      expect(r3.rejected).toBe(true)
      expect(r3.banner).toContain('Server is at capacity')

      r1.client.end()
      r2.client.end()
      r3.client.end()
      await limitSrv.close()
    })

    it('probabilistically drops connections between soft and hard limit', async () => {
      // softLimit=3, hardLimit=50 gives a very wide ramp.
      // Hold 8 connections: p = (8-3)/(50-3) ≈ 11%. With 50 attempts,
      // we expect ~6 rejections and ~44 accepts - definitely a mix.
      const probSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        softLimit: 3,
        hardLimit: 50,
        execTimeout: 5000,
        docsDir,
      })
      const probPort = await probSrv.listen()

      // Fill 8 slots (above soft limit to be in the ramp zone)
      const held: Client[] = []
      for (let i = 0; i < 8; i++) {
        const r = await connectWithBanner(probPort)
        if (!r.rejected) held.push(r.client)
      }

      // Attempt connections and count outcomes
      let accepted = 0
      let rejected = 0
      for (let i = 0; i < 50; i++) {
        const r = await connectWithBanner(probPort)
        if (r.rejected) {
          rejected++
        } else {
          accepted++
          r.client.end()
          // Allow cleanup before next attempt
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }

      // Should see a mix - not all accepted, not all rejected
      expect(accepted).toBeGreaterThan(0)
      expect(rejected).toBeGreaterThan(0)

      for (const c of held) c.end()
      await probSrv.close()
    })

    it('disconnects idle clients with timeout message', async () => {
      const client = await connectClient()

      const result = await new Promise<{ disconnected: boolean; stdout: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ disconnected: false, stdout: '' }), 10_000)
        let stdout = ''
        client.on('close', () => {
          clearTimeout(timer)
          resolve({ disconnected: true, stdout })
        })
        // Open a shell but don't send anything - let idle timeout fire
        client.shell((err, stream) => {
          if (err) return
          stream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })
        })
      })

      expect(result.disconnected).toBe(true)
      expect(result.stdout).toContain('Session timed out')
    }, 10_000)

    it('disconnects after max session timeout with message', async () => {
      const shortSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        sessionTimeout: 500,
        execTimeout: 5000,
        docsDir,
      })
      const shortPort = await shortSrv.listen()

      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: shortPort,
          username: 'test',
          password: 'ignored',
        })
      })

      const result = await new Promise<{ disconnected: boolean; stdout: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ disconnected: false, stdout: '' }), 10_000)
        let stdout = ''
        client.on('close', () => {
          clearTimeout(timer)
          resolve({ disconnected: true, stdout })
        })
        // Keep sending data - idle timeout won't fire, but max session should
        client.shell((err, stream) => {
          if (err) return
          stream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })
          const keepAlive = setInterval(() => stream.write('echo ping\n'), 100)
          stream.on('close', () => clearInterval(keepAlive))
        })
      })

      expect(result.disconnected).toBe(true)
      expect(result.stdout).toContain('Session timed out')
      await shortSrv.close()
    }, 10_000)

    it('force-disconnects exec channels after drain timeout with notification', async () => {
      const drainTimeout = 500
      const shutdownSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 30_000,
        docsDir,
      })
      const shutdownPort = await shutdownSrv.listen()

      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: shutdownPort,
          username: 'test',
          password: 'ignored',
        })
      })

      const result = await new Promise<{ stdout: string; code: number | null; elapsed: number }>(
        (resolve, reject) => {
          client.exec('sleep 10', (err, stream) => {
            if (err) return reject(err)
            let stdout = ''
            let exitCode: number | null = null
            stream.on('data', (data: Buffer) => {
              stdout += data.toString()
            })
            stream.on('exit', (code: number | null) => {
              exitCode = code
            })
            // stream.on('close') may not fire when connection ends abruptly
            const closeStart = Date.now()
            client.on('close', () =>
              resolve({ stdout, code: exitCode, elapsed: Date.now() - closeStart }),
            )

            // Give the command a moment to start, then trigger shutdown
            setTimeout(() => {
              closeStart
              shutdownSrv.close('Server is shutting down\n', drainTimeout)
            }, 500)
          })
        },
      )

      expect(result.stdout).toContain('Server is shutting down')
      expect(result.code).toBe(255)
      // Disconnected after drain timeout, not immediately and not after full sleep 10
      expect(result.elapsed).toBeGreaterThanOrEqual(drainTimeout * 0.8)
      expect(result.elapsed).toBeLessThan(5000)
    }, 10_000)

    it('force-disconnects shell channels after drain timeout with notification', async () => {
      const drainTimeout = 500
      const shutdownSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 5000,
        docsDir,
      })
      const shutdownPort = await shutdownSrv.listen()

      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: shutdownPort,
          username: 'test',
          password: 'ignored',
        })
      })

      const result = await new Promise<{ stdout: string; code: number; elapsed: number }>(
        (resolve, reject) => {
          client.shell((err, stream) => {
            if (err) return reject(err)
            let stdout = ''
            let closeStart = 0
            stream.on('data', (data: Buffer) => {
              stdout += data.toString()
            })
            stream.on('close', (code: number) =>
              resolve({ stdout, code, elapsed: Date.now() - closeStart }),
            )

            // Wait for prompt, then trigger shutdown
            const waitForPrompt = () => {
              if (stdout.includes('$ ')) {
                closeStart = Date.now()
                shutdownSrv.close('Server is shutting down\n', drainTimeout)
              } else {
                setTimeout(waitForPrompt, 50)
              }
            }
            waitForPrompt()
          })
        },
      )

      expect(result.stdout).toContain('Server is shutting down')
      expect(result.code).toBe(255)
      // Disconnected after drain timeout, not immediately
      expect(result.elapsed).toBeGreaterThanOrEqual(drainTimeout * 0.8)
      expect(result.elapsed).toBeLessThan(5000)
    }, 10_000)

    it('rejects new connections during shutdown drain', async () => {
      const shutdownSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 30_000,
        docsDir,
      })
      const shutdownPort = await shutdownSrv.listen()

      // Connect a client with a long-running command to keep the server draining
      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: shutdownPort,
          username: 'test',
          password: 'ignored',
        })
      })
      client.exec('sleep 30', () => {})

      // Start shutdown with long drain - server should stop accepting but wait
      const closePromise = shutdownSrv.close('Shutting down\n', 5000)

      // Try to connect during drain window
      const rejected = await new Promise<boolean>((resolve) => {
        const lateClient = new Client()
        clients.push(lateClient)
        lateClient.on('ready', () => resolve(false))
        lateClient.on('close', () => resolve(true))
        lateClient.on('error', () => resolve(true))
        lateClient.connect({
          host: '127.0.0.1',
          port: shutdownPort,
          username: 'test',
          password: 'ignored',
        })
      })

      expect(rejected).toBe(true)

      client.end()
      await closePromise
    }, 10_000)

    it('drains naturally without notifying when connections finish before timeout', async () => {
      const shutdownSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 5000,
        docsDir,
      })
      const shutdownPort = await shutdownSrv.listen()

      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: shutdownPort,
          username: 'test',
          password: 'ignored',
        })
      })

      // Run a fast command
      const execDone = new Promise<{ stdout: string; code: number }>((resolve, reject) => {
        client.exec('echo fast', (err, stream) => {
          if (err) return reject(err)
          let stdout = ''
          stream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })
          stream.on('close', (code: number) => resolve({ stdout, code }))
        })
      })

      // Start shutdown with long drain - command should finish naturally
      const closePromise = shutdownSrv.close('Should not see this\n', 5000)

      const result = await execDone
      expect(result.stdout).toBe('fast\n')
      expect(result.code).toBe(0)

      // Client disconnects naturally after command completes
      client.end()
      await closePromise

      // Should NOT have received the shutdown notification (only command output)
      expect(result.stdout).not.toContain('Should not see this')
    }, 10_000)
  })

  describe('per-IP concurrency limiting', () => {
    it('rejects when IP exceeds max concurrent connections', async () => {
      const concSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 5000,
        maxConnectionsPerIp: 2,
        docsDir,
      })
      const concPort = await concSrv.listen()

      // Fill to the limit
      const r1 = await connectWithBanner(concPort)
      const r2 = await connectWithBanner(concPort)
      expect(r1.rejected).toBe(false)
      expect(r2.rejected).toBe(false)

      // Third connection from same IP should be rejected at auth
      const r3 = await connectWithBanner(concPort)
      expect(r3.rejected).toBe(true)
      expect(r3.banner).toContain('Too many concurrent connections')

      // After disconnecting, a new connection should work
      r1.client.end()
      r3.client.end()
      await new Promise((r) => setTimeout(r, 100))
      const r4 = await connectWithBanner(concPort)
      expect(r4.rejected).toBe(false)
      const result2 = await execCommand(r4.client, 'echo hi')
      expect(result2.stdout).toBe('hi\n')
      expect(result2.code).toBe(0)

      r2.client.end()
      r4.client.end()
      await concSrv.close()
    })
  })

  describe('rate limiting', () => {
    it('rejects at auth with rate limit banner when limited', async () => {
      const rateLimiter: RateLimiter = {
        limit: async () => ({ success: false, reset: Date.now() + 30_000 }),
      }
      const rlSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 5000,
        docsDir,
        rateLimiter,
      })
      const rlPort = await rlSrv.listen()

      const r = await connectWithBanner(rlPort)
      expect(r.rejected).toBe(true)
      expect(r.banner).toContain('Too many connections')
      expect(r.banner).toContain('Retry in')

      r.client.end()
      await rlSrv.close()
    })

    it('allows exec when rate limit passes', async () => {
      const rateLimiter: RateLimiter = {
        limit: async () => ({ success: true, reset: 0 }),
      }
      const rlSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 5000,
        docsDir,
        rateLimiter,
      })
      const rlPort = await rlSrv.listen()

      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({ host: '127.0.0.1', port: rlPort, username: 'test', password: 'ignored' })
      })

      const { stdout, code } = await execCommand(client, 'echo hello')
      expect(stdout).toBe('hello\n')
      expect(code).toBe(0)

      client.end()
      await rlSrv.close()
    })

    it('fails open when rate limiter throws', async () => {
      const rateLimiter: RateLimiter = {
        limit: async () => {
          throw new Error('Redis connection failed')
        },
      }
      const rlSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        execTimeout: 5000,
        docsDir,
        rateLimiter,
      })
      const rlPort = await rlSrv.listen()

      const client = new Client()
      clients.push(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve()).on('error', reject)
        client.connect({ host: '127.0.0.1', port: rlPort, username: 'test', password: 'ignored' })
      })

      const { stdout, code } = await execCommand(client, 'echo hello')
      expect(stdout).toBe('hello\n')
      expect(code).toBe(0)

      client.end()
      await rlSrv.close()
    })
  })

  describe('HTTP endpoints', () => {
    it('/healthz returns status and active connections', async () => {
      const res = await metricsApp.request('/healthz')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(typeof body.activeConnections).toBe('number')
      expect(typeof body.uptimeSeconds).toBe('number')
    })

    it('/metrics returns prometheus format with custom metrics', async () => {
      // Run a command so counters are non-zero
      const client = await connectClient()
      await execCommand(client, 'echo metrics-test')

      const res = await metricsApp.request('/metrics')
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(res.headers.get('content-type')).toContain('text/plain')
      expect(text).toContain('ssh_commands_total')
      expect(text).toContain('ssh_active_connections')
      expect(text).toContain('ssh_command_duration_seconds')
      expect(text).toContain('process_resident_memory_bytes')
    })
  })
})
