import { run, type ScenarioConfig, type LatencyStats } from '../runner.js'
import type { SessionProfile } from '../profiles/types.js'

export const description = 'Gradual linear ramp simulating real traffic growth'

export interface RampResult {
  targetVUs: number
  rampUpSeconds: number
  holdSeconds: number
  rampDownSeconds: number
  commandLatency: LatencyStats
  connectLatency: LatencyStats
  commands: number
  errors: number
  rejections: number
  commandsPerSecond: number
}

/**
 * Ramp up from 0 to targetVUs, hold at peak, then ramp back down.
 * Simulates realistic traffic growth and validates autoscale in both directions.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl?: string
  profile: SessionProfile
  targetVUs?: number
  rampUpSeconds?: number
  holdSeconds?: number
  rampDownSeconds?: number
}): Promise<RampResult> {
  const targetVUs = opts.targetVUs ?? 3000
  const rampUpSeconds = opts.rampUpSeconds ?? 300 // 5 min ramp (arrival rate model)
  const holdSeconds = opts.holdSeconds ?? 0 // no hold needed with loop=false
  const rampDownSeconds = opts.rampDownSeconds ?? 0 // VUs exit on their own

  console.log(
    `\nGradual Ramp - 0 → ${targetVUs} VUs over ${rampUpSeconds}s, hold ${holdSeconds}s, ramp down ${rampDownSeconds}s\n`
  )

  const config: ScenarioConfig = {
    host: opts.host,
    port: opts.port,
    metricsUrl: opts.metricsUrl,
    vus: targetVUs,
    durationSeconds: rampUpSeconds + holdSeconds,
    rampUpSeconds,
    rampDownSeconds,
    profile: opts.profile,
    loop: false,
    onProgress: (stats) => {
      console.log(
        `  [${stats.elapsedSeconds}s] VUs=${stats.activeVUs} cmds=${stats.totalCommands} errors=${stats.totalErrors} rejections=${stats.totalRejections}`
      )
    },
    progressIntervalMs: 15_000,
  }

  const result = await run(config)
  const totalRejections =
    result.rejections.capacity + result.rejections.rateLimit + result.rejections.concurrency

  console.log('\n--- Summary ---')
  console.log(
    `Target: ${targetVUs} VUs | Ramp up: ${rampUpSeconds}s | Hold: ${holdSeconds}s | Ramp down: ${rampDownSeconds}s`
  )
  console.log(
    `p50=${result.commandLatency.p50.toFixed(0)}ms  p95=${result.commandLatency.p95.toFixed(0)}ms  p99=${result.commandLatency.p99.toFixed(0)}ms  max=${result.commandLatency.max.toFixed(0)}ms`
  )
  console.log(
    `Commands: ${result.totalCommands} (${result.commandsPerSecond.toFixed(1)}/s) | Errors: ${result.serverErrors} | Rejections: ${totalRejections}`
  )
  if (result.errorSamples.length > 0) {
    console.log('\n--- Errors ---')
    for (const e of result.errorSamples.slice(0, 10)) {
      console.log(`  [${e.type}] x${e.count}: ${e.message.slice(0, 120)}`)
    }
  }

  return {
    targetVUs,
    rampUpSeconds,
    holdSeconds,
    rampDownSeconds,
    commandLatency: result.commandLatency,
    connectLatency: result.connectLatency,
    commands: result.totalCommands,
    errors: result.serverErrors,
    rejections: totalRejections,
    commandsPerSecond: result.commandsPerSecond,
  }
}
