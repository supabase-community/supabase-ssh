export interface MetricsSnapshot {
  timestamp: number
  raw: string
  parsed: Record<string, number>
}

export interface HealthStatus {
  status: string
  activeConnections: number
  uptimeSeconds: number
}

/** Fetch and parse Prometheus metrics from the SSH server */
export async function scrapeMetrics(metricsUrl: string): Promise<MetricsSnapshot> {
  const res = await fetch(`${metricsUrl}/metrics`)
  const raw = await res.text()
  return {
    timestamp: Date.now(),
    raw,
    parsed: parsePrometheusText(raw),
  }
}

/** Fetch health status from the SSH server */
export async function scrapeHealth(metricsUrl: string): Promise<HealthStatus> {
  const res = await fetch(`${metricsUrl}/healthz`)
  return res.json() as Promise<HealthStatus>
}

/** Compute deltas between two snapshots for counter/gauge metrics */
export function computeDeltas(
  before: MetricsSnapshot,
  after: MetricsSnapshot,
): Record<string, number> {
  const deltas: Record<string, number> = {}
  for (const [key, value] of Object.entries(after.parsed)) {
    const prev = before.parsed[key] ?? 0
    deltas[key] = value - prev
  }
  return deltas
}

/**
 * Parse Prometheus text format into a flat key-value map.
 * Handles counters, gauges, and histogram sum/count. Skips comments and TYPE lines.
 */
function parsePrometheusText(text: string): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    // Match: metric_name{labels} value or metric_name value
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+(-?[\d.eE+-]+)/)
    if (match) {
      metrics[match[1]] = parseFloat(match[2])
    }
  }
  return metrics
}

/** Trigger GC on the server, then wait briefly for RSS to settle */
export async function triggerGC(metricsUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${metricsUrl}/gc`, { method: 'POST' })
    const body = (await res.json()) as { triggered: boolean }
    if (body.triggered) {
      // Brief pause for RSS to reflect the freed memory
      await new Promise((r) => setTimeout(r, 200))
    }
    return body.triggered
  } catch {
    return false
  }
}

// --- VictoriaMetrics time-series queries ---

const VICTORIA_METRICS_URL = 'http://localhost:8428'

export interface TimeSeriesPoint {
  timestamp: number
  value: number
}

/** Query VictoriaMetrics for a metric over a time range (PromQL range query) */
export async function queryRange(
  metric: string,
  startUnix: number,
  endUnix: number,
  step = '5s',
): Promise<TimeSeriesPoint[]> {
  const params = new URLSearchParams({
    query: metric,
    start: String(startUnix),
    end: String(endUnix),
    step,
  })
  const res = await fetch(`${VICTORIA_METRICS_URL}/api/v1/query_range?${params}`)
  const body = (await res.json()) as {
    data?: { result?: Array<{ values?: Array<[number, string]> }> }
  }
  const values = body.data?.result?.[0]?.values ?? []
  return values.map(([ts, val]) => ({ timestamp: ts, value: parseFloat(val) }))
}

/** Query VictoriaMetrics for the current value of a metric (PromQL instant query) */
export async function queryInstant(metric: string): Promise<number | null> {
  const params = new URLSearchParams({ query: metric })
  const res = await fetch(`${VICTORIA_METRICS_URL}/api/v1/query?${params}`)
  const body = (await res.json()) as {
    data?: { result?: Array<{ value?: [number, string] }> }
  }
  const val = body.data?.result?.[0]?.value?.[1]
  return val != null ? parseFloat(val) : null
}

/** Check if VictoriaMetrics is reachable */
export async function isVictoriaMetricsAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${VICTORIA_METRICS_URL}/health`)
    return res.ok
  } catch {
    return false
  }
}

/** Key metrics we care about for load testing */
export const METRIC_KEYS = {
  activeConnections: 'ssh_active_connections',
  sessionsTotal: 'ssh_sessions_total',
  commandsTotal: 'ssh_commands_total',
  commandErrors: 'ssh_command_errors_total',
  commandTimeouts: 'ssh_command_timeouts_total',
  connectionRejections: 'ssh_connection_rejections_total',
  rateLimitRejections: 'ssh_rate_limit_rejections_total',
  concurrencyRejections: 'ssh_concurrency_rejections_total',
  processMemory: 'process_resident_memory_bytes',
} as const
