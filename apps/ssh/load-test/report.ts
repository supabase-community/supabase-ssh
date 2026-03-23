import type { ScenarioResult, LatencyStats } from './runner.js'
import { METRIC_KEYS } from './metrics-collector.js'

/** Format a latency stats object as a compact string */
function fmtLatency(stats: LatencyStats): string {
  if (stats.count === 0) return 'n/a'
  return `p50=${stats.p50.toFixed(0)}ms  p95=${stats.p95.toFixed(0)}ms  p99=${stats.p99.toFixed(0)}ms  max=${stats.max.toFixed(0)}ms`
}

/** Format bytes as human-readable */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`
}

export interface ReportOptions {
  scenarioName: string
  config?: { vus: number; durationSeconds: number; profileName?: string }
}

/** Generate a text report from scenario results */
export function formatReport(result: ScenarioResult, opts: ReportOptions): string {
  const lines: string[] = []

  lines.push(`=== ${opts.scenarioName} ===`)
  if (opts.config) {
    const parts = [`Duration: ${result.durationSeconds.toFixed(0)}s`, `VUs: ${opts.config.vus}`]
    if (opts.config.profileName) parts.push(`Profile: ${opts.config.profileName}`)
    lines.push(parts.join(' | '))
  }
  lines.push('')

  // Connections
  const totalRejections =
    result.rejections.capacity + result.rejections.rateLimit + result.rejections.concurrency
  lines.push('Connections:')
  lines.push(
    `  Total: ${result.totalConnections}  Successful: ${result.successfulConnections}  Rejected: ${totalRejections}`
  )
  if (totalRejections > 0) {
    lines.push(
      `  Rejections: capacity=${result.rejections.capacity}  rate_limit=${result.rejections.rateLimit}  concurrency=${result.rejections.concurrency}`
    )
  }
  lines.push('')

  // Commands
  lines.push('Commands:')
  lines.push(
    `  Total: ${result.totalCommands}  Completed: ${result.completedCommands}  Server Errors: ${result.serverErrors}  Non-zero Exits: ${result.nonZeroExits}`
  )
  lines.push(`  Throughput: ${result.commandsPerSecond.toFixed(2)} cmd/s`)
  lines.push('')

  // Latency
  lines.push('Latency:')
  lines.push(`  Connect:  ${fmtLatency(result.connectLatency)}`)
  lines.push(`  Command:  ${fmtLatency(result.commandLatency)}`)
  lines.push('')

  // Server metrics
  if (result.metricDeltas) {
    lines.push('Server Metrics (delta):')
    const interesting = [
      ['ssh_sessions_total', 'Sessions'],
      ['ssh_commands_total', 'Commands'],
      ['ssh_command_errors_total', 'Command errors'],
      ['ssh_command_timeouts_total', 'Timeouts'],
      ['ssh_connection_rejections_total', 'Capacity rejections'],
      ['ssh_rate_limit_rejections_total', 'Rate limit rejections'],
      ['ssh_concurrency_rejections_total', 'Concurrency rejections'],
    ] as const

    for (const [key, label] of interesting) {
      // Sum across all label combinations
      let total = 0
      for (const [metricKey, value] of Object.entries(result.metricDeltas)) {
        if (metricKey === key || metricKey.startsWith(`${key}{`)) {
          total += value
        }
      }
      if (total !== 0) {
        lines.push(`  ${label}: +${total}`)
      }
    }

    // Memory (point-in-time, not delta)
    if (result.metricsAfter?.parsed[METRIC_KEYS.processMemory]) {
      lines.push(
        `  Memory: ${fmtBytes(result.metricsAfter.parsed[METRIC_KEYS.processMemory])}`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Format result as JSON */
export function formatJSON(result: ScenarioResult, opts: ReportOptions): string {
  return JSON.stringify(
    {
      scenario: opts.scenarioName,
      ...result,
      // Strip raw metrics text from JSON output
      metricsBefore: undefined,
      metricsAfter: undefined,
    },
    null,
    2
  )
}
