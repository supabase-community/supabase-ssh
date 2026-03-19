import { run, type ScenarioConfig, type ScenarioResult, type LatencyStats } from '../runner.js'
import type { SessionProfile } from '../profiles/types.js'

export const description = 'Step ramp to find latency cliff and timeout onset'

export interface StepResult {
  vus: number
  commandLatency: LatencyStats
  connectLatency: LatencyStats
  commands: number
  errors: number
  rejections: number
  commandsPerSecond: number
}

export interface LatencyUnderLoadResult {
  steps: StepResult[]
  inflectionPoint?: { vus: number; p95Ms: number }
}

const STEPS = [5, 10, 20, 40, 60, 80, 100, 120]
const STEP_DURATION_SECONDS = 60

/**
 * Run a step-ramp latency test. Each step runs for 60s at a fixed VU count.
 * Outputs a latency-vs-concurrency curve.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl?: string
  profile: SessionProfile
  steps?: number[]
  stepDurationSeconds?: number
}): Promise<LatencyUnderLoadResult> {
  const steps = opts.steps ?? STEPS
  const stepDuration = opts.stepDurationSeconds ?? STEP_DURATION_SECONDS
  const results: StepResult[] = []

  console.log(`\nLatency Under Load - ${steps.length} steps, ${stepDuration}s each\n`)

  for (const vus of steps) {
    console.log(`  Step: ${vus} VUs for ${stepDuration}s...`)

    const config: ScenarioConfig = {
      host: opts.host,
      port: opts.port,
      metricsUrl: opts.metricsUrl,
      vus,
      durationSeconds: stepDuration,
      profile: opts.profile,
      loop: true,
    }

    const result = await run(config)
    const totalRejections =
      result.rejections.capacity + result.rejections.rateLimit + result.rejections.concurrency

    results.push({
      vus,
      commandLatency: result.commandLatency,
      connectLatency: result.connectLatency,
      commands: result.successfulCommands + result.failedCommands,
      errors: result.failedCommands,
      rejections: totalRejections,
      commandsPerSecond: result.commandsPerSecond,
    })

    console.log(
      `    p50=${result.commandLatency.p50.toFixed(0)}ms  p95=${result.commandLatency.p95.toFixed(0)}ms  p99=${result.commandLatency.p99.toFixed(0)}ms  errors=${result.failedCommands}  rejections=${totalRejections}`
    )
  }

  // Find inflection point: first step where p95 > 2x the baseline (step 0)
  let inflectionPoint: LatencyUnderLoadResult['inflectionPoint']
  if (results.length >= 2 && results[0].commandLatency.p95 > 0) {
    const baseline = results[0].commandLatency.p95
    for (const step of results) {
      if (step.commandLatency.p95 > baseline * 2) {
        inflectionPoint = { vus: step.vus, p95Ms: step.commandLatency.p95 }
        break
      }
    }
  }

  console.log('\n--- Summary ---')
  console.log('VUs  |  p50     p95     p99     max     | cmd/s  | errors | rejections')
  console.log('-----|-----------------------------------|--------|--------|----------')
  for (const s of results) {
    const l = s.commandLatency
    console.log(
      `${String(s.vus).padStart(4)} | ${l.p50.toFixed(0).padStart(5)}ms ${l.p95.toFixed(0).padStart(5)}ms ${l.p99.toFixed(0).padStart(5)}ms ${l.max.toFixed(0).padStart(5)}ms | ${s.commandsPerSecond.toFixed(1).padStart(6)} | ${String(s.errors).padStart(6)} | ${String(s.rejections).padStart(10)}`
    )
  }

  if (inflectionPoint) {
    console.log(
      `\nInflection point: ${inflectionPoint.vus} VUs (p95 = ${inflectionPoint.p95Ms.toFixed(0)}ms, >2x baseline)`
    )
  } else {
    console.log('\nNo inflection point detected within tested range')
  }

  return { steps: results, inflectionPoint }
}
