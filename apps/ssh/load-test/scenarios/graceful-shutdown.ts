import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { generateHostKey } from '../runner.js'
import { connect, exec } from '../ssh-client.js'

export const description = 'Server restart during active load - verify drain behavior'

export interface GracefulShutdownResult {
  activeSessionsAtShutdown: number
  receivedShutdownMessage: boolean
  drainCompletedWithinTimeout: boolean
  serverExitCode: number | null
  inFlightCommandsCompleted: number
}

/**
 * Spawn a server, connect clients, send SIGTERM, verify drain behavior.
 */
export async function execute(opts: {
  /** Seconds to wait before sending SIGTERM (default 10) */
  warmupSeconds?: number
  /** Number of active clients (default 10) */
  vus?: number
}): Promise<GracefulShutdownResult> {
  const warmupSeconds = opts.warmupSeconds ?? 10
  const vus = opts.vus ?? 10
  const port = 2299 // Use a fixed port for the spawned server
  const drainTimeout = 15_000

  console.log(`\nGraceful Shutdown - ${vus} VUs, SIGTERM after ${warmupSeconds}s\n`)

  // Write host key to temp location
  const hostKey = generateHostKey()

  // Spawn server as child process
  const sshRoot = join(import.meta.dirname, '..')
  const serverProcess = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    cwd: sshRoot,
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: '0', // Disable metrics for this test
      SSH_HOST_KEY: hostKey.toString('utf-8'),
      IDLE_TIMEOUT: '30000',
      SESSION_TIMEOUT: '60000',
      EXEC_TIMEOUT: '10000',
      MAX_CONNECTIONS: '50',
      DRAIN_TIMEOUT: String(drainTimeout),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let _serverOutput = ''
  serverProcess.stdout?.on('data', (data: Buffer) => {
    _serverOutput += data.toString()
  })
  serverProcess.stderr?.on('data', (data: Buffer) => {
    _serverOutput += data.toString()
  })

  // Wait for server to start
  console.log('  Waiting for server to start...')
  await waitForPort(port, 10_000)
  console.log(`  Server running on port ${port}`)

  // Connect clients
  console.log(`  Connecting ${vus} clients...`)
  const clients = []
  for (let i = 0; i < vus; i++) {
    try {
      const connected = await connect({ host: '127.0.0.1', port })
      if (!connected.rejected) {
        clients.push(connected)
      }
    } catch {
      // Ignore connection errors during warmup
    }
  }
  console.log(`  ${clients.length} clients connected`)

  // Warmup - run some commands
  console.log(`  Running commands for ${warmupSeconds}s...`)
  await new Promise((resolve) => setTimeout(resolve, warmupSeconds * 1000))

  // Send SIGTERM
  console.log('  Sending SIGTERM...')
  serverProcess.kill('SIGTERM')

  // Check if clients receive shutdown message
  let receivedShutdownMessage = false
  let inFlightCompleted = 0

  // Try to run a command on each client after SIGTERM
  const commandPromises = clients.map(async (c) => {
    try {
      const result = await exec(c.client, 'echo still-alive')
      if (result.stdout.includes('still-alive')) {
        inFlightCompleted++
      }
      // Check stderr for shutdown message
      if (result.stderr.includes('update in progress') || result.stderr.includes('reconnect')) {
        receivedShutdownMessage = true
      }
    } catch {
      // Expected - connection may close
    }
  })

  // Also listen for banner/data on any client that might have shutdown message
  for (const c of clients) {
    c.client.on('banner', (msg: string) => {
      if (msg.includes('update') || msg.includes('reconnect')) {
        receivedShutdownMessage = true
      }
    })
  }

  // Wait for drain or timeout
  const exitCode = await Promise.race([
    waitForExit(serverProcess),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), drainTimeout + 5000)),
  ])

  await Promise.allSettled(commandPromises)
  const drainCompleted = exitCode !== null

  // Cleanup
  for (const c of clients) {
    try {
      c.client.end()
      c.client.destroy()
    } catch {
      // Already disconnected
    }
  }

  if (!drainCompleted) {
    serverProcess.kill('SIGKILL')
  }

  console.log('\n--- Summary ---')
  console.log(`  Active sessions at shutdown: ${clients.length}`)
  console.log(`  Received shutdown message: ${receivedShutdownMessage}`)
  console.log(`  Drain completed: ${drainCompleted}`)
  console.log(`  Server exit code: ${exitCode}`)
  console.log(`  In-flight commands completed: ${inFlightCompleted}`)

  const pass = drainCompleted && (exitCode === 0 || exitCode === null)
  console.log(`\nResult: ${pass ? 'PASS' : 'FAIL'}`)

  return {
    activeSessionsAtShutdown: clients.length,
    receivedShutdownMessage,
    drainCompletedWithinTimeout: drainCompleted,
    serverExitCode: exitCode,
    inFlightCommandsCompleted: inFlightCompleted,
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const connected = await connect({ host: '127.0.0.1', port, timeout: 1000 })
      connected.client.end()
      connected.client.destroy()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new Error(`Port ${port} not available after ${timeoutMs}ms`)
}

function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    proc.on('exit', (code) => resolve(code ?? 1))
  })
}
