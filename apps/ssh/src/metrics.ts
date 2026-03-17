import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

const register = new Registry()

collectDefaultMetrics({ register })

// --- Gauges (point-in-time) ---

const activeConnections = new Gauge({
  name: 'ssh_active_connections',
  help: 'Current number of open SSH connections',
  registers: [register],
})

const memoryRssBytes = new Gauge({
  name: 'ssh_memory_rss_bytes',
  help: 'Process RSS in bytes',
  registers: [register],
  collect() {
    memoryRssBytes.set(process.memoryUsage().rss)
  },
})

const memoryHeapUsedBytes = new Gauge({
  name: 'ssh_memory_heap_used_bytes',
  help: 'V8 heap used in bytes',
  registers: [register],
  collect() {
    memoryHeapUsedBytes.set(process.memoryUsage().heapUsed)
  },
})

const memoryExternalBytes = new Gauge({
  name: 'ssh_memory_external_bytes',
  help: 'V8 external memory (Buffers) in bytes',
  registers: [register],
  collect() {
    memoryExternalBytes.set(process.memoryUsage().external)
  },
})

// --- Counters (monotonic) ---

const connectionsTotal = new Counter({
  name: 'ssh_connections_total',
  help: 'Total SSH connections',
  labelNames: ['mode'] as const,
  registers: [register],
})

const connectionRejectionsTotal = new Counter({
  name: 'ssh_connection_rejections_total',
  help: 'Connections rejected at capacity',
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

export function incConnections(mode: 'exec' | 'shell') {
  activeConnectionCount++
  activeConnections.inc()
  connectionsTotal.inc({ mode })
}

export function decConnections() {
  activeConnectionCount--
  activeConnections.dec()
}

export function incConnectionRejections() {
  connectionRejectionsTotal.inc()
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

let activeConnectionCount = 0

export function getActiveConnectionCount(): number {
  return activeConnectionCount
}

export function getRegistry(): Registry {
  return register
}
