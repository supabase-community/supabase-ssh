import { Hono } from 'hono'
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

const register = new Registry()

collectDefaultMetrics({ register })

// --- Gauges (point-in-time) ---

const activeConnections = new Gauge({
  name: 'ssh_active_connections',
  help: 'Current number of TCP-level SSH connections',
  registers: [register],
})

// --- Counters (monotonic) ---

const sessionsTotal = new Counter({
  name: 'ssh_sessions_total',
  help: 'Total SSH sessions (exec or shell)',
  labelNames: ['mode'] as const,
  registers: [register],
})

const connectionRejectionsTotal = new Counter({
  name: 'ssh_connection_rejections_total',
  help: 'Connections rejected at capacity',
  registers: [register],
})

const rateLimitRejectionsTotal = new Counter({
  name: 'ssh_rate_limit_rejections_total',
  help: 'Connections rejected by per-IP rate limiting',
  registers: [register],
})

const concurrencyRejectionsTotal = new Counter({
  name: 'ssh_concurrency_rejections_total',
  help: 'Connections rejected by per-IP concurrency limit',
  registers: [register],
})

const commandsTotal = new Counter({
  name: 'ssh_commands_total',
  help: 'Total commands executed',
  labelNames: ['command', 'exit_code'] as const,
  registers: [register],
})

const commandErrorsTotal = new Counter({
  name: 'ssh_command_errors_total',
  help: 'Commands that exited with non-zero code',
  registers: [register],
})

const commandTimeoutsTotal = new Counter({
  name: 'ssh_command_timeouts_total',
  help: 'Commands that hit the exec timeout',
  registers: [register],
})

// --- Histograms (distributions) ---

const commandDurationSeconds = new Histogram({
  name: 'ssh_command_duration_seconds',
  help: 'Command execution duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
})

const sessionDurationSeconds = new Histogram({
  name: 'ssh_session_duration_seconds',
  help: 'Session duration in seconds',
  labelNames: ['mode', 'end_reason'] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
})

// --- Helper functions ---

export function incActiveConnections() {
  activeConnections.inc()
}

export function decActiveConnections() {
  activeConnections.dec()
}

export function incSessions(mode: 'exec' | 'shell') {
  sessionsTotal.inc({ mode })
}

export function incConnectionRejections() {
  connectionRejectionsTotal.inc()
}

export function incRateLimitRejections() {
  rateLimitRejectionsTotal.inc()
}

export function incConcurrencyRejections() {
  concurrencyRejectionsTotal.inc()
}

export function incCommands(command: string, exitCode: number) {
  const firstWord = command.split(/\s+/)[0] ?? 'unknown'
  commandsTotal.inc({ command: firstWord, exit_code: String(exitCode) })
  if (exitCode !== 0) {
    commandErrorsTotal.inc()
  }
}

export function incCommandTimeouts() {
  commandTimeoutsTotal.inc()
}

export function observeCommandDuration(seconds: number) {
  commandDurationSeconds.observe(seconds)
}

export function observeSessionDuration(seconds: number, mode: string, endReason: string) {
  sessionDurationSeconds.observe({ mode, end_reason: endReason }, seconds)
}

/** Creates an internal HTTP server for /metrics and /healthz. */
export function createMetricsServer(opts: { getActiveConnections: () => number }) {
  const app = new Hono()

  app.get('/metrics', async (c) => {
    const metrics = await register.metrics()
    return c.text(metrics, 200, { 'Content-Type': register.contentType })
  })

  app.post('/gc', (c) => {
    if (typeof globalThis.gc === 'function') {
      globalThis.gc()
      return c.json({ triggered: true })
    }
    return c.json({ triggered: false }, 501)
  })

  app.get('/healthz', (c) => {
    return c.json({
      status: 'ok',
      activeConnections: opts.getActiveConnections(),
      uptimeSeconds: Math.floor(process.uptime()),
    })
  })

  return app
}
