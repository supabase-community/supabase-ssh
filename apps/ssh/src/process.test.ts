import { type ChildProcess, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}) as string

const SERVER_PATH = resolve(import.meta.dirname, 'server.ts')
const DOCS_DIR = mkdtempSync(join(tmpdir(), 'ssh-test-docs-'))

/** Spawn the server process and wait until it's listening. Returns the bound port. */
function spawnServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', SERVER_PATH], {
      env: {
        ...process.env,
        SSH_HOST_KEY: hostKey,
        PORT: '0',
        IDLE_TIMEOUT_MS: '30000',
        MAX_CONNECTIONS: '10',
        EXEC_TIMEOUT: '5000',
        DRAIN_TIMEOUT: '1000',
        METRICS_PORT: '0',
        DOCS_DIR,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`Server didn't start in time. stdout: ${stdout}, stderr: ${stderr}`))
    }, 10_000)

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      const match = stdout.match(/SSH server listening on port (\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve({ proc, port: parseInt(match[1], 10) })
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    proc.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== null) {
        reject(new Error(`Server exited early with code ${code}. stderr: ${stderr}`))
      }
    })
  })
}

function connectClient(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'test', password: 'ignored' })
  })
}

function execCommand(client: Client, command: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      stream.on('close', (code: number) => resolve({ stdout, code }))
    })
  })
}

function waitForExit(proc: ChildProcess, timeout = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(null)
    }, timeout)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

// ---------------------------------------------------------------------------
// Process-level tests
// ---------------------------------------------------------------------------
describe('Server process', () => {
  let proc: ChildProcess | null = null

  afterEach(() => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL')
    }
    proc = null
  })

  it('starts and accepts SSH connections', async () => {
    const server = await spawnServer()
    proc = server.proc

    const client = await connectClient(server.port)
    const { stdout, code } = await execCommand(client, 'echo works')
    expect(stdout).toBe('works\n')
    expect(code).toBe(0)
    client.end()
  }, 15_000)

  it('SIGTERM graceful shutdown notifies active sessions', async () => {
    const server = await spawnServer()
    proc = server.proc

    const client = await connectClient(server.port)

    // Open a shell session so we have an active channel
    const shutdownMessage = await new Promise<string>((resolve, reject) => {
      client.shell((err, stream) => {
        if (err) return reject(err)
        let buf = ''
        const onData = (data: Buffer) => {
          buf += data.toString()
          if (buf.includes('reconnect')) {
            resolve(buf)
          }
        }
        stream.on('data', onData)
        stream.stderr.on('data', onData)
        // Wait for shell to be ready, then send SIGTERM
        const waitForPrompt = () => {
          if (buf.includes('$ ')) {
            proc?.kill('SIGTERM')
          } else {
            setTimeout(waitForPrompt, 50)
          }
        }
        waitForPrompt()
      })
    })

    expect(shutdownMessage).toContain('reconnect in a few seconds')

    const code = await waitForExit(proc)
    expect(code).toBe(0)
    client.destroy()
  }, 15_000)

  it('SIGINT graceful shutdown notifies active sessions', async () => {
    const server = await spawnServer()
    proc = server.proc

    const client = await connectClient(server.port)

    const shutdownMessage = await new Promise<string>((resolve, reject) => {
      client.shell((err, stream) => {
        if (err) return reject(err)
        let buf = ''
        const onData = (data: Buffer) => {
          buf += data.toString()
          if (buf.includes('reconnect')) {
            resolve(buf)
          }
        }
        stream.on('data', onData)
        stream.stderr.on('data', onData)
        const waitForPrompt = () => {
          if (buf.includes('$ ')) {
            proc?.kill('SIGINT')
          } else {
            setTimeout(waitForPrompt, 50)
          }
        }
        waitForPrompt()
      })
    })

    expect(shutdownMessage).toContain('reconnect in a few seconds')

    const code = await waitForExit(proc)
    expect(code).toBe(0)
    client.destroy()
  }, 15_000)
})
