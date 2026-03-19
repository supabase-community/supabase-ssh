import { run, type ScenarioConfig } from '../runner.js'
import { formatReport, type ReportOptions } from '../report.js'
import type { SessionProfile } from '../profiles/types.js'

export const description = 'Sustained load at expected operating point'

/**
 * Steady-state test: sustained concurrent sessions at ~60-70% of hard limit.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl?: string
  profile: SessionProfile
  vus?: number
  durationSeconds?: number
}) {
  const vus = opts.vus ?? 20
  const duration = opts.durationSeconds ?? 300

  console.log(`\nSteady State - ${vus} VUs, ${duration}s\n`)

  const config: ScenarioConfig = {
    host: opts.host,
    port: opts.port,
    metricsUrl: opts.metricsUrl,
    vus,
    durationSeconds: duration,
    rampUpSeconds: 30,
    profile: opts.profile,
    loop: true,
    onProgress: (stats) => {
      process.stdout.write(
        `  [${stats.elapsedSeconds}s] VUs=${stats.activeVUs} cmds=${stats.totalCommands} errors=${stats.totalErrors} rejections=${stats.totalRejections}\r`
      )
    },
  }

  const result = await run(config)
  console.log('')

  const reportOpts: ReportOptions = {
    scenarioName: 'Steady State',
    config: { vus, durationSeconds: duration, profileName: opts.profile.name },
  }
  console.log(formatReport(result, reportOpts))

  // Pass/fail
  const totalRejections =
    result.rejections.capacity + result.rejections.rateLimit + result.rejections.concurrency
  const errorRate =
    result.successfulCommands + result.failedCommands > 0
      ? result.failedCommands / (result.successfulCommands + result.failedCommands)
      : 0

  const pass = totalRejections === 0 && errorRate < 0.01 && result.commandLatency.p95 < 2000
  console.log(`Result: ${pass ? 'PASS' : 'FAIL'}`)

  if (!pass) {
    if (totalRejections > 0) console.log(`  - ${totalRejections} rejections (expected 0)`)
    if (errorRate >= 0.01) console.log(`  - Error rate ${(errorRate * 100).toFixed(1)}% (expected <1%)`)
    if (result.commandLatency.p95 >= 2000)
      console.log(`  - Command p95 ${result.commandLatency.p95.toFixed(0)}ms (expected <2000ms)`)
  }

  return { result, pass }
}
