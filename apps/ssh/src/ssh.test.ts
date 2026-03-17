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
    maxConnections: 2,
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
    it('rejects connections beyond max', async () => {
      const c1 = await connectClient()
      const c2 = await connectClient()

      // Third connection should be rejected
      const rejected = await new Promise<boolean>((resolve) => {
        const c3 = new Client()
        clients.push(c3)
        c3.on('ready', () => resolve(false))
        c3.on('close', () => resolve(true))
        c3.on('error', () => resolve(true))
        c3.connect({ host: '127.0.0.1', port, username: 'test', password: 'ignored' })
      })

      expect(rejected).toBe(true)

      // Clean up first two so afterEach doesn't fight them
      c1.end()
      c2.end()
    })

    it('disconnects idle clients', async () => {
      const client = await connectClient()

      const disconnected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000)
        client.on('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
        // Open a shell but don't send anything - let idle timeout fire
        client.shell(() => {})
      })

      expect(disconnected).toBe(true)
    }, 10_000)

    it('disconnects after max session timeout even if active', async () => {
      const shortSrv = createSSHServer({
        hostKey: Buffer.from(hostKey),
        port: 0,
        idleTimeout: 30_000,
        maxSessionTimeout: 500,
        maxConnections: 2,
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

      const disconnected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000)
        client.on('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
        // Keep sending data - idle timeout won't fire, but max session should
        client.shell((err, stream) => {
          if (err) return
          const keepAlive = setInterval(() => stream.write('echo ping\n'), 100)
          stream.on('close', () => clearInterval(keepAlive))
        })
      })

      expect(disconnected).toBe(true)
      await shortSrv.close()
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
