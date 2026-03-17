import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Client } from 'ssh2'
import { createSSHServer } from './ssh.js'
import { app } from './http.js'

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}) as string

const docsDir = mkdtempSync(join(tmpdir(), 'ssh-test-docs-'))

let port: number
let srv: ReturnType<typeof createSSHServer>
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

function execCommand(
  client: Client,
  command: string
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

      const connectTo = (p: number) =>
        new Promise<Client>((resolve, reject) => {
          const client = new Client()
          clients.push(client)
          client
            .on('ready', () => resolve(client))
            .on('error', reject)
            .connect({ host: '127.0.0.1', port: p, username: 'test', password: 'ignored' })
        })

      const c1 = await connectTo(limitPort)
      const c2 = await connectTo(limitPort)

      // Third connection should be rejected (at hard limit)
      const rejected = await new Promise<boolean>((resolve) => {
        const c3 = new Client()
        clients.push(c3)
        c3.on('ready', () => resolve(false))
        c3.on('close', () => resolve(true))
        c3.on('error', () => resolve(true))
        c3.connect({ host: '127.0.0.1', port: limitPort, username: 'test', password: 'ignored' })
      })

      expect(rejected).toBe(true)

      c1.end()
      c2.end()
      await limitSrv.close()
    })

    it('probabilistically drops connections between soft and hard limit', async () => {
      // softLimit=3, hardLimit=13 gives a wide ramp (10 slots)
      // Fill to softLimit-1 (2 connections), then attempt 20 more.
      // With linear ramp, some should be accepted and some rejected.
      const probSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        softLimit: 3,
        hardLimit: 13,
        execTimeout: 5000,
        docsDir,
      })
      const probPort = await probSrv.listen()

      const connectTo = (p: number) =>
        new Promise<Client>((resolve, reject) => {
          const client = new Client()
          clients.push(client)
          client
            .on('ready', () => resolve(client))
            .on('error', reject)
            .connect({ host: '127.0.0.1', port: p, username: 'test', password: 'ignored' })
        })

      // Fill 2 slots (below soft limit, always accepted)
      const baseline = await Promise.all([connectTo(probPort), connectTo(probPort)])

      // Attempt 20 more connections in the ramp zone
      let accepted = 0
      let rejected = 0
      for (let i = 0; i < 20; i++) {
        const result = await new Promise<'accepted' | 'rejected'>((resolve) => {
          const client = new Client()
          clients.push(client)
          client.on('ready', () => resolve('accepted'))
          client.on('close', () => resolve('rejected'))
          client.on('error', () => resolve('rejected'))
          client.connect({ host: '127.0.0.1', port: probPort, username: 'test', password: 'ignored' })
        })
        if (result === 'accepted') accepted++
        else rejected++
      }

      // With a ramp from 3 to 13, we should see a mix - not all accepted, not all rejected
      expect(accepted).toBeGreaterThan(0)
      expect(rejected).toBeGreaterThan(0)

      for (const c of baseline) c.end()
      for (const c of clients) c.end()
      await probSrv.close()
    })

    it('disconnects idle clients with timeout message', async () => {
      const client = await connectClient()

      const result = await new Promise<{ disconnected: boolean; stderr: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ disconnected: false, stderr: '' }), 10_000)
        let stderr = ''
        client.on('close', () => {
          clearTimeout(timer)
          resolve({ disconnected: true, stderr })
        })
        // Open a shell but don't send anything - let idle timeout fire
        client.shell((err, stream) => {
          if (err) return
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })
        })
      })

      expect(result.disconnected).toBe(true)
      expect(result.stderr).toContain('Session timed out')
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
        client.connect({ host: '127.0.0.1', port: shortPort, username: 'test', password: 'ignored' })
      })

      const result = await new Promise<{ disconnected: boolean; stderr: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ disconnected: false, stderr: '' }), 10_000)
        let stderr = ''
        client.on('close', () => {
          clearTimeout(timer)
          resolve({ disconnected: true, stderr })
        })
        // Keep sending data - idle timeout won't fire, but max session should
        client.shell((err, stream) => {
          if (err) return
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })
          const keepAlive = setInterval(() => stream.write('echo ping\n'), 100)
          stream.on('close', () => clearInterval(keepAlive))
        })
      })

      expect(result.disconnected).toBe(true)
      expect(result.stderr).toContain('Session timed out')
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
        client.connect({ host: '127.0.0.1', port: shutdownPort, username: 'test', password: 'ignored' })
      })

      const result = await new Promise<{ stderr: string; code: number | null; elapsed: number }>(
        (resolve, reject) => {
          client.exec('sleep 10', (err, stream) => {
            if (err) return reject(err)
            let stderr = ''
            let exitCode: number | null = null
            stream.stderr.on('data', (data: Buffer) => {
              stderr += data.toString()
            })
            stream.on('exit', (code: number | null) => {
              exitCode = code
            })
            // stream.on('close') may not fire when connection ends abruptly
            const closeStart = Date.now()
            client.on('close', () =>
              resolve({ stderr, code: exitCode, elapsed: Date.now() - closeStart })
            )

            // Give the command a moment to start, then trigger shutdown
            setTimeout(() => {
              closeStart
              shutdownSrv.close('Server is shutting down\n', drainTimeout)
            }, 500)
          })
        }
      )

      expect(result.stderr).toContain('Server is shutting down')
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
        client.connect({ host: '127.0.0.1', port: shutdownPort, username: 'test', password: 'ignored' })
      })

      const result = await new Promise<{ stderr: string; code: number; elapsed: number }>(
        (resolve, reject) => {
          client.shell((err, stream) => {
            if (err) return reject(err)
            let stdout = ''
            let stderr = ''
            let closeStart = 0
            stream.on('data', (data: Buffer) => {
              stdout += data.toString()
            })
            stream.stderr.on('data', (data: Buffer) => {
              stderr += data.toString()
            })
            stream.on('close', (code: number) =>
              resolve({ stderr, code, elapsed: Date.now() - closeStart })
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
        }
      )

      expect(result.stderr).toContain('Server is shutting down')
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
        client.connect({ host: '127.0.0.1', port: shutdownPort, username: 'test', password: 'ignored' })
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
        lateClient.connect({ host: '127.0.0.1', port: shutdownPort, username: 'test', password: 'ignored' })
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
        client.connect({ host: '127.0.0.1', port: shutdownPort, username: 'test', password: 'ignored' })
      })

      // Run a fast command and collect any stderr (shutdown message)
      let stderr = ''
      const execDone = new Promise<{ stdout: string; code: number }>((resolve, reject) => {
        client.exec('echo fast', (err, stream) => {
          if (err) return reject(err)
          let stdout = ''
          stream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
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

      // Should NOT have received the shutdown notification
      expect(stderr).toBe('')
    }, 10_000)
  })

  describe('HTTP endpoints', () => {
    it('/healthz returns status and active connections', async () => {
      const res = await app.request('/healthz')
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

      const res = await app.request('/metrics')
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(res.headers.get('content-type')).toContain('text/plain')
      expect(text).toContain('ssh_commands_total')
      expect(text).toContain('ssh_active_connections')
      expect(text).toContain('ssh_command_duration_seconds')
      expect(text).toContain('ssh_memory_rss_bytes')
    })
  })
})
