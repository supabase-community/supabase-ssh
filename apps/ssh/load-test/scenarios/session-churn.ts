import { connect, exec } from '../ssh-client.js'
import { scrapeMetrics, METRIC_KEYS } from '../metrics-collector.js'

export const description = 'Rapid connect/exec/disconnect cycles to find throughput limits and resource leaks'

export interface SessionChurnResult {
  steps: Array<{
    vus: number
    totalCycles: number
    successRate: number
    connectP95Ms: number
    commandP95Ms: number
    cyclesPerSecond: number
    memoryBytes: number
  }>
  memoryStable: boolean
}

const STEPS = [5, 10, 20, 40]
const STEP_DURATION_SECONDS = 60

/**
 * Rapid connect -> exec -> disconnect cycles with no think time.
 * Tests connection setup/teardown throughput and resource cleanup.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl: string
  steps?: number[]
  stepDurationSeconds?: number
}): Promise<SessionChurnResult> {
  const steps = opts.steps ?? STEPS
  const stepDuration = opts.stepDurationSeconds ?? STEP_DURATION_SECONDS

  console.log(`\nSession Churn - ${steps.length} steps, ${stepDuration}s each\n`)

  const results: SessionChurnResult['steps'] = []

  for (const vus of steps) {
    console.log(`  Step: ${vus} VUs doing rapid churn...`)

    const connectTimes: number[] = []
    const commandTimes: number[] = []
    let successes = 0
    let failures = 0
    const stopSignal = { stopped: false }
    const startTime = performance.now()

    // Churn VUs
    const vuFns = Array.from({ length: vus }, () =>
      (async () => {
        while (!stopSignal.stopped) {
          try {
            const connected = await connect({ host: opts.host, port: opts.port })
            if (connected.rejected) {
              failures++
              continue
            }
            connectTimes.push(connected.connectTimeMs)

            const result = await exec(connected.client, 'echo ok')
            commandTimes.push(result.commandTimeMs)

            connected.client.end()
            connected.client.destroy()
            successes++
          } catch {
            failures++
          }
        }
      })()
    )

    // Wait for step duration
    await new Promise((resolve) => setTimeout(resolve, stepDuration * 1000))
    stopSignal.stopped = true
    await Promise.allSettled(vuFns)

    const elapsed = (performance.now() - startTime) / 1000
    const totalCycles = successes + failures
    const successRate = totalCycles > 0 ? successes / totalCycles : 0

    // Sort for percentiles
    connectTimes.sort((a, b) => a - b)
    commandTimes.sort((a, b) => a - b)

    const p95 = (arr: number[]) => arr.length > 0 ? arr[Math.floor(arr.length * 0.95)] : 0

    // Check memory
    const snapshot = await scrapeMetrics(opts.metricsUrl)
    const memory = snapshot.parsed[METRIC_KEYS.processMemory] ?? 0

    results.push({
      vus,
      totalCycles,
      successRate,
      connectP95Ms: p95(connectTimes),
      commandP95Ms: p95(commandTimes),
      cyclesPerSecond: totalCycles / elapsed,
      memoryBytes: memory,
    })

    console.log(
      `    ${totalCycles} cycles | ${(successRate * 100).toFixed(1)}% success | ${(totalCycles / elapsed).toFixed(1)} cycles/s | connect p95=${p95(connectTimes).toFixed(0)}ms | memory=${(memory / 1024 / 1024).toFixed(1)}MB`
    )
  }

  // Check if memory is stable across steps (no more than 2x growth)
  const memoryValues = results.map((r) => r.memoryBytes).filter((m) => m > 0)
  const memoryStable =
    memoryValues.length < 2 ||
    memoryValues[memoryValues.length - 1] < memoryValues[0] * 2

  console.log('\n--- Summary ---')
  console.log('VUs  | Cycles | Success | Cycles/s | Connect p95 | Cmd p95 | Memory')
  console.log('-----|--------|---------|----------|-------------|---------|-------')
  for (const s of results) {
    console.log(
      `${String(s.vus).padStart(4)} | ${String(s.totalCycles).padStart(6)} | ${(s.successRate * 100).toFixed(1).padStart(6)}% | ${s.cyclesPerSecond.toFixed(1).padStart(8)} | ${s.connectP95Ms.toFixed(0).padStart(9)}ms | ${s.commandP95Ms.toFixed(0).padStart(5)}ms | ${(s.memoryBytes / 1024 / 1024).toFixed(1).padStart(5)}MB`
    )
  }
  console.log(`\nMemory stable: ${memoryStable ? 'yes' : 'NO - possible leak'}`)

  return { steps: results, memoryStable }
}
