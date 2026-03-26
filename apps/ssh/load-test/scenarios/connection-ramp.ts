import { METRIC_KEYS, scrapeMetrics } from '../metrics-collector.js'
import { type ConnectedClient, connect } from '../ssh-client.js'

export const description = 'Linear ramp to beyond hard limit - verify rejection curve'

export interface ConnectionRampResult {
  steps: Array<{
    targetConnections: number
    activeConnections: number
    rejections: { capacity: number; rateLimit: number; concurrency: number }
    memoryBytes: number
  }>
  softLimitObserved: number | null
  hardLimitObserved: number | null
}

/**
 * Ramp connections linearly, holding each batch. Observe where rejections start
 * (soft limit) and where they reach 100% (hard limit).
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl: string
  /** Max connections to attempt (default 120) */
  maxConnections?: number
  /** Connections to add per step (default 5) */
  stepSize?: number
  /** Seconds to hold at each step (default 10) */
  holdSeconds?: number
}): Promise<ConnectionRampResult> {
  const maxConn = opts.maxConnections ?? 120
  const stepSize = opts.stepSize ?? 5
  const holdSeconds = opts.holdSeconds ?? 10

  console.log(`\nConnection Ramp - 0 to ${maxConn}, step ${stepSize}, hold ${holdSeconds}s\n`)

  const results: ConnectionRampResult['steps'] = []
  const allClients: ConnectedClient[] = []
  let softLimitObserved: number | null = null
  let hardLimitObserved: number | null = null

  try {
    for (let target = stepSize; target <= maxConn; target += stepSize) {
      const needed = target - allClients.length
      const rejections = { capacity: 0, rateLimit: 0, concurrency: 0 }

      for (let i = 0; i < needed; i++) {
        try {
          const connected = await connect({ host: opts.host, port: opts.port })
          if (connected.rejected) {
            const type = connected.rejectionType
            if (type === 'capacity') rejections.capacity++
            else if (type === 'rate_limit') rejections.rateLimit++
            else if (type === 'concurrency') rejections.concurrency++
          } else {
            allClients.push(connected)
          }
        } catch {
          rejections.capacity++
        }
      }

      await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000))

      const snapshot = await scrapeMetrics(opts.metricsUrl)
      const memory = snapshot.parsed[METRIC_KEYS.processMemory] ?? 0
      const totalRejections = rejections.capacity + rejections.rateLimit + rejections.concurrency

      results.push({
        targetConnections: target,
        activeConnections: allClients.length,
        rejections,
        memoryBytes: memory,
      })

      console.log(
        `  Target: ${target} | Active: ${allClients.length} | Rejected: ${totalRejections} | Memory: ${(memory / 1024 / 1024).toFixed(1)}MB`,
      )

      // Detect soft limit (first rejection)
      if (softLimitObserved === null && totalRejections > 0) {
        softLimitObserved = allClients.length
      }

      // Detect hard limit (all rejected in a step)
      if (hardLimitObserved === null && totalRejections === needed && needed > 0) {
        hardLimitObserved = allClients.length
      }

      // Stop if fully blocked
      if (totalRejections === needed && needed >= stepSize) {
        console.log('    All connections rejected - stopping ramp')
        break
      }
    }
  } finally {
    console.log(`\n  Closing ${allClients.length} connections...`)
    for (const c of allClients) {
      c.client.end()
      c.client.destroy()
    }
  }

  console.log('\n--- Summary ---')
  console.log('Target | Active | Capacity | Rate | Concurrency | Memory')
  console.log('-------|--------|----------|------|-------------|-------')
  for (const s of results) {
    console.log(
      `${String(s.targetConnections).padStart(6)} | ${String(s.activeConnections).padStart(6)} | ${String(s.rejections.capacity).padStart(8)} | ${String(s.rejections.rateLimit).padStart(4)} | ${String(s.rejections.concurrency).padStart(11)} | ${(s.memoryBytes / 1024 / 1024).toFixed(1).padStart(5)}MB`,
    )
  }

  if (softLimitObserved) console.log(`\nSoft limit observed at: ${softLimitObserved} connections`)
  if (hardLimitObserved) console.log(`Hard limit observed at: ${hardLimitObserved} connections`)

  return { steps: results, softLimitObserved, hardLimitObserved }
}
