import { execSync, execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { rmSync } from 'node:fs'

const IMAGE_NAME = 'supabase-ssh-loadtest'
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')

export interface ServerConfig {
  /** Memory limit (e.g., '256m', '512m', '1g'). Omit for no limit. */
  memory?: string
  /** CPU limit (e.g., '1', '0.5', '2'). Maps to Docker --cpus. Omit for no limit. */
  cpus?: string
  /** Environment variables passed to the container */
  env?: Record<string, string>
  /** Host port for SSH (default: auto-assigned) */
  sshPort?: number
  /** Host port for metrics (default: auto-assigned) */
  metricsPort?: number
}

export interface RunningServer {
  containerId: string
  sshPort: number
  metricsPort: number
  metricsUrl: string
  stop: () => Promise<void>
}

/** Presets for common load test configurations */
export const presets = {
  /** Discovery: all limits disabled, no rate limiter */
  discovery: (memory?: string, cpus?: string): ServerConfig => ({
    memory,
    cpus,
    env: {
      MAX_CONNECTIONS: '9999',
      MAX_CONNECTIONS_PER_IP: '9999',
      IDLE_TIMEOUT: '300000',
      SESSION_TIMEOUT: '3600000',
    },
  }),
  /** Validation: real limits enabled */
  validation: (overrides?: Record<string, string>): ServerConfig => ({
    env: {
      MAX_CONNECTIONS: '100',
      MAX_CONNECTIONS_PER_IP: '10',
      ...overrides,
    },
  }),
  /** Capture: vanilla server with OTel export to host collector */
  capture: (): ServerConfig => ({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://host.docker.internal:4318',
    },
  }),
} as const

let imageBuilt = false

/** Build the Docker image (cached, only runs once per process) */
export function buildImage(): void {
  if (imageBuilt) return
  console.log('Building Docker image...')
  execSync(`docker build -f apps/ssh/Dockerfile -t ${IMAGE_NAME} .`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  })
  imageBuilt = true
  console.log('Docker image built.')
}

/** Stop any leftover server containers from previous runs */
function cleanupStaleContainers() {
  try {
    const stale = execFileSync(
      'docker', ['ps', '-q', '--filter', 'label=supabase-ssh-loadtest'],
      { encoding: 'utf-8' }
    ).trim()
    if (stale) {
      console.log('Cleaning up stale server container...')
      execSync(`docker stop ${stale}`, { stdio: 'pipe' })
    }
  } catch {
    // Nothing to clean up
  }
}

/** Start an SSH server container with the given config */
export async function startServer(config: ServerConfig = {}): Promise<RunningServer> {
  cleanupStaleContainers()
  buildImage()

  const args = ['run', '--rm', '-d', '--label', 'supabase-ssh-loadtest']

  // Port mapping: use specified ports or let Docker assign
  if (config.sshPort) {
    args.push('-p', `${config.sshPort}:22`)
  } else {
    args.push('-p', '22')
  }
  // Pin metrics to 9091 so VictoriaMetrics (docker-compose) can scrape it
  const metricsPort = config.metricsPort ?? 9091
  args.push('-p', `${metricsPort}:9091`)

  // Memory limit
  if (config.memory) {
    args.push('--memory', config.memory)
    // Disable swap to get accurate OOM behavior
    args.push('--memory-swap', config.memory)
  }

  // CPU limit
  if (config.cpus) {
    args.push('--cpus', config.cpus)
  }

  // Expose GC so load tests can trigger it via POST /gc for accurate memory measurements
  args.push('-e', 'NODE_OPTIONS=--expose-gc')

  // Generate a host key so the container doesn't need one on disk
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  args.push('-e', `SSH_HOST_KEY=${hostKey}`)

  // Environment variables
  for (const [key, value] of Object.entries(config.env ?? {})) {
    args.push('-e', `${key}=${value}`)
  }

  args.push(IMAGE_NAME)

  const containerId = execFileSync('docker', args, { encoding: 'utf-8' }).trim()

  // Resolve assigned ports
  const sshPort = config.sshPort ?? getHostPort(containerId, 22)
  const metricsUrl = `http://localhost:${metricsPort}`

  // Wait for the server to be ready
  await waitForReady(sshPort, metricsUrl)

  return {
    containerId,
    sshPort,
    metricsPort,
    metricsUrl,
    stop: async () => {
      try {
        execSync(`docker stop ${containerId}`, { stdio: 'pipe' })
      } catch {
        // Already stopped
      }
    },
  }
}

/** Get the host port mapped to a container port */
function getHostPort(containerId: string, containerPort: number): number {
  const output = execSync(
    `docker port ${containerId} ${containerPort}/tcp`,
    { encoding: 'utf-8' }
  ).trim()
  // Format: "0.0.0.0:12345" or "[::]:12345"
  const match = output.match(/:(\d+)$/)
  if (!match) throw new Error(`Could not parse port from: ${output}`)
  return parseInt(match[1], 10)
}

/** Ensure OTel collector is running (via docker compose). Idempotent. */
export async function ensureOtelCollector(): Promise<void> {
  try {
    const res = await fetch('http://localhost:4318/v1/traces', { method: 'POST', body: '{}' })
    // 4xx is fine - means it's listening
    if (res.status < 500) return
  } catch {
    // Not running
  }

  console.log('Starting OTel collector...')
  try {
    execSync('docker compose up -d otel-collector', {
      cwd: `${REPO_ROOT}/apps/ssh`,
      stdio: 'pipe',
    })
  } catch {
    // Port conflict from a previous run - check if it's actually healthy
    try {
      const res = await fetch('http://localhost:4318/v1/traces', { method: 'POST', body: '{}' })
      if (res.status < 500) {
        console.log('OTel collector already running.')
        return
      }
    } catch {
      // genuinely broken
    }
    throw new Error('Failed to start OTel collector - port 4318 may be in use by a non-compose container')
  }

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:4318/v1/traces', { method: 'POST', body: '{}' })
      if (res.status < 500) {
        console.log('OTel collector ready.')
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('OTel collector did not become ready - continuing without it')
}

/** Restart OTel collector with a fresh spans file. Deletes old spans and restarts the container. */
export async function resetOtelCollector(): Promise<void> {
  const spansPath = `${REPO_ROOT}/apps/ssh/load-test/traces/spans.json`
  rmSync(spansPath, { force: true })

  execSync('docker compose restart otel-collector', {
    cwd: `${REPO_ROOT}/apps/ssh`,
    stdio: 'pipe',
  })

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:4318/v1/traces', { method: 'POST', body: '{}' })
      if (res.status < 500) {
        console.log('OTel collector restarted with fresh spans.')
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('OTel collector did not become ready after restart')
}

/** Ensure VictoriaMetrics is running (via docker compose). Idempotent. */
export async function ensureVictoriaMetrics(): Promise<void> {
  // Check if already running
  try {
    const res = await fetch('http://localhost:8428/health')
    if (res.ok) return
  } catch {
    // Not running
  }

  console.log('Starting VictoriaMetrics...')
  execSync('docker compose up -d victoriametrics', {
    cwd: `${REPO_ROOT}/apps/ssh`,
    stdio: 'pipe',
  })

  // Wait for it to be ready
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:8428/health')
      if (res.ok) {
        console.log('VictoriaMetrics ready.')
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('VictoriaMetrics did not become ready - continuing without it')
}

/** Wait for SSH and metrics endpoints to be ready */
async function waitForReady(sshPort: number, metricsUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  const deadline = start + timeoutMs

  // Wait for metrics endpoint (HTTP is easier to check)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${metricsUrl}/healthz`)
      if (res.ok) {
        console.log(`Server ready (SSH: ${sshPort}, Metrics: ${metricsUrl})`)
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`)
}
