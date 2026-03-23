import { run, type ScenarioConfig, type LatencyStats } from '../runner.js'

export const description = 'Concurrent heavy greps to find CPU contention ceiling'

export interface ExpensiveCommandsResult {
  steps: Array<{
    vus: number
    commandLatency: LatencyStats
    commands: number
    errors: number
    timeouts: number
    commandsPerSecond: number
  }>
  timeoutOnsetVUs: number | null
}

const STEPS = [5, 10, 20, 40]
const STEP_DURATION_SECONDS = 60

const EXPENSIVE_PROFILE = {
  name: 'expensive-grep',
  description: 'Heavy recursive grep across all docs',
  commands: [
    { command: "grep -r 'authentication' /supabase/docs/", offset: 0 },
  ],
}

/**
 * Run increasingly concurrent expensive commands to find CPU contention ceiling.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl?: string
  steps?: number[]
  stepDurationSeconds?: number
}): Promise<ExpensiveCommandsResult> {
  const steps = opts.steps ?? STEPS
  const stepDuration = opts.stepDurationSeconds ?? STEP_DURATION_SECONDS

  console.log(`\nExpensive Commands - ${steps.length} steps, ${stepDuration}s each\n`)

  const results: ExpensiveCommandsResult['steps'] = []

  for (const vus of steps) {
    console.log(`  Step: ${vus} VUs running heavy grep...`)

    const config: ScenarioConfig = {
      host: opts.host,
      port: opts.port,
      metricsUrl: opts.metricsUrl,
      vus,
      durationSeconds: stepDuration,
      profile: EXPENSIVE_PROFILE,
      loop: true,
    }

    const result = await run(config)

    results.push({
      vus,
      commandLatency: result.commandLatency,
      commands: result.totalCommands,
      errors: result.serverErrors,
      timeouts: 0, // TODO: parse from metrics delta
      commandsPerSecond: result.commandsPerSecond,
    })

    console.log(
      `    p50=${result.commandLatency.p50.toFixed(0)}ms  p95=${result.commandLatency.p95.toFixed(0)}ms  max=${result.commandLatency.max.toFixed(0)}ms  errors=${result.serverErrors}`
    )
  }

  // Find timeout onset
  const timeoutOnset = results.find((r) => r.errors > 0)
  const timeoutOnsetVUs = timeoutOnset?.vus ?? null

  console.log('\n--- Summary ---')
  console.log('VUs  |  p50     p95     p99     max     | cmd/s  | errors')
  console.log('-----|-----------------------------------|--------|-------')
  for (const s of results) {
    const l = s.commandLatency
    console.log(
      `${String(s.vus).padStart(4)} | ${l.p50.toFixed(0).padStart(5)}ms ${l.p95.toFixed(0).padStart(5)}ms ${l.p99.toFixed(0).padStart(5)}ms ${l.max.toFixed(0).padStart(5)}ms | ${s.commandsPerSecond.toFixed(1).padStart(6)} | ${String(s.errors).padStart(6)}`
    )
  }

  if (timeoutOnsetVUs) {
    console.log(`\nTimeout onset: ${timeoutOnsetVUs} VUs`)
  }

  return { steps: results, timeoutOnsetVUs }
}
