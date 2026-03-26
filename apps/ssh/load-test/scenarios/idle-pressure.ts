import { METRIC_KEYS, scrapeMetrics, triggerGC } from '../metrics-collector.js'
import { type ConnectedClient, connect } from '../ssh-client.js'

export const description =
  'Ramp idle connections to find memory ceiling and per-connection overhead'

export interface IdlePressureResult {
  baselineMemoryBytes: number
  steps: Array<{
    connections: number
    memoryBytes: number
    deltaMemoryBytes: number
    deltaConnections: number
    memoryPerConnectionBytes: number
    allConnected: boolean
    rejections: number
  }>
  maxConnectionsBeforeOOM: number | null
  avgMemoryPerConnection: number
}

const STEPS = [10, 20, 40, 60, 80, 100, 120, 150, 200]
const HOLD_SECONDS = 15

/** Trigger GC then scrape memory - gives a consistent post-GC reading */
async function measureMemory(metricsUrl: string): Promise<number> {
  await triggerGC(metricsUrl)
  const snapshot = await scrapeMetrics(metricsUrl)
  return snapshot.parsed[METRIC_KEYS.processMemory] ?? 0
}

/**
 * Ramp idle connections step by step, measuring memory at each level.
 * Uses forced GC + step-to-step deltas for accurate per-connection overhead.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl: string
  steps?: number[]
  holdSeconds?: number
}): Promise<IdlePressureResult> {
  const steps = opts.steps ?? STEPS
  const holdSeconds = opts.holdSeconds ?? HOLD_SECONDS

  console.log(`\nIdle Connection Pressure - ${steps.length} steps, hold ${holdSeconds}s each\n`)

  // Baseline: memory with 0 connections (post-GC)
  const baselineMemory = await measureMemory(opts.metricsUrl)
  console.log(`  Baseline memory (post-GC): ${(baselineMemory / 1024 / 1024).toFixed(1)}MB`)

  const results: IdlePressureResult['steps'] = []
  const allClients: ConnectedClient[] = []

  try {
    for (const targetCount of steps) {
      const needed = targetCount - allClients.length
      let rejections = 0

      console.log(`  Opening ${needed} connections (target: ${targetCount})...`)

      // Open connections to reach target
      for (let i = 0; i < needed; i++) {
        try {
          const connected = await connect({ host: opts.host, port: opts.port })
          if (connected.rejected) {
            rejections++
          } else {
            allClients.push(connected)
          }
        } catch {
          rejections++
        }
      }

      // Hold for measurement
      await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000))

      // Measure memory (post-GC for consistency)
      const currentMemory = await measureMemory(opts.metricsUrl)
      const activeConns = allClients.length

      // Compute per-connection overhead as delta from previous step
      const prevMemory =
        results.length > 0 ? results[results.length - 1].memoryBytes : baselineMemory
      const prevConns = results.length > 0 ? results[results.length - 1].connections : 0
      const deltaMemory = currentMemory - prevMemory
      const deltaConns = activeConns - prevConns
      const memPerConn = deltaConns > 0 ? deltaMemory / deltaConns : 0

      results.push({
        connections: activeConns,
        memoryBytes: currentMemory,
        deltaMemoryBytes: deltaMemory,
        deltaConnections: deltaConns,
        memoryPerConnectionBytes: memPerConn,
        allConnected: rejections === 0,
        rejections,
      })

      console.log(
        `    ${activeConns} connected | Memory: ${(currentMemory / 1024 / 1024).toFixed(1)}MB | +${(deltaMemory / 1024).toFixed(1)}KB / +${deltaConns} conns = ${(memPerConn / 1024).toFixed(1)}KB/conn | Rejections: ${rejections}`,
      )

      // If we got rejections, we've likely hit a limit - stop ramping
      if (rejections > needed / 2) {
        console.log('    High rejection rate - stopping ramp')
        break
      }
    }
  } finally {
    // Clean up all connections
    console.log(`\n  Closing ${allClients.length} connections...`)
    for (const c of allClients) {
      c.client.end()
      c.client.destroy()
    }
  }

  // Compute average per-connection overhead from step deltas (skip outliers)
  const perConnSamples = results
    .filter((r) => r.deltaConnections > 0 && r.memoryPerConnectionBytes > 0)
    .map((r) => r.memoryPerConnectionBytes)
  const avgMemPerConn =
    perConnSamples.length > 0
      ? perConnSamples.reduce((a, b) => a + b, 0) / perConnSamples.length
      : 0

  // Find max connections before OOM (if any step failed)
  const lastSuccessful = results.filter((r) => r.allConnected)
  const maxConnections =
    lastSuccessful.length > 0 ? lastSuccessful[lastSuccessful.length - 1].connections : null

  console.log('\n--- Summary ---')
  console.log('Conns | Memory    | Delta     | Per Conn  | Rejections')
  console.log('------|-----------|-----------|-----------|----------')
  for (const s of results) {
    console.log(
      `${String(s.connections).padStart(5)} | ${(s.memoryBytes / 1024 / 1024).toFixed(1).padStart(7)}MB | ${(s.deltaMemoryBytes / 1024).toFixed(1).padStart(7)}KB | ${(s.memoryPerConnectionBytes / 1024).toFixed(1).padStart(7)}KB | ${String(s.rejections).padStart(10)}`,
    )
  }
  console.log(`\nBaseline (post-GC): ${(baselineMemory / 1024 / 1024).toFixed(1)}MB`)
  console.log(`Avg memory per connection: ${(avgMemPerConn / 1024).toFixed(1)}KB`)
  if (maxConnections !== null) {
    console.log(`Max connections (all successful): ${maxConnections}`)
  }

  return {
    baselineMemoryBytes: baselineMemory,
    steps: results,
    maxConnectionsBeforeOOM: maxConnections,
    avgMemoryPerConnection: avgMemPerConn,
  }
}
