import {
  isVictoriaMetricsAvailable,
  METRIC_KEYS,
  queryRange,
  scrapeMetrics,
} from '../metrics-collector.js'
import type { SessionProfile } from '../profiles/types.js'
import { run, type ScenarioConfig } from '../runner.js'

export const description = 'Long duration test to detect memory leaks'

export interface MemorySoakResult {
  durationSeconds: number
  samples: Array<{ elapsedSeconds: number; memoryMB: number }>
  startMemoryMB: number
  endMemoryMB: number
  peakMemoryMB: number
  /** Linear regression slope in MB/minute */
  slopeMBPerMinute: number
  /** Whether the slope suggests a leak (> 0.5 MB/min after warmup) */
  likelyLeak: boolean
  /** Whether VictoriaMetrics was used (vs fallback polling) */
  source: 'victoriametrics' | 'polling'
}

const DEFAULT_VUS = 10
const DEFAULT_DURATION = 1800 // 30 min
const WARMUP_SECONDS = 60

/**
 * Run sustained load, then query VictoriaMetrics for memory time-series.
 * Falls back to in-process polling if VictoriaMetrics isn't available.
 */
export async function execute(opts: {
  host: string
  port: number
  metricsUrl: string
  profile: SessionProfile
  vus?: number
  durationSeconds?: number
}): Promise<MemorySoakResult> {
  const vus = opts.vus ?? DEFAULT_VUS
  const duration = opts.durationSeconds ?? DEFAULT_DURATION
  const useVM = await isVictoriaMetricsAvailable()

  console.log(`\nMemory Soak - ${vus} VUs, ${duration}s duration`)
  console.log(
    `  Metrics source: ${useVM ? 'VictoriaMetrics (5s scrape)' : 'direct polling (10s)'}\n`,
  )

  const startUnix = Math.floor(Date.now() / 1000)

  // Fallback: poll directly if VictoriaMetrics isn't running
  const pollSamples: Array<{ elapsedSeconds: number; memoryMB: number }> = []
  let pollTimer: ReturnType<typeof setInterval> | undefined
  if (!useVM) {
    const startTime = performance.now()
    pollTimer = setInterval(async () => {
      try {
        const snapshot = await scrapeMetrics(opts.metricsUrl)
        const memory = snapshot.parsed[METRIC_KEYS.processMemory] ?? 0
        const elapsed = (performance.now() - startTime) / 1000
        const mb = memory / 1024 / 1024
        pollSamples.push({ elapsedSeconds: Math.round(elapsed), memoryMB: mb })
        process.stdout.write(`  [${Math.round(elapsed)}s] Memory: ${mb.toFixed(1)}MB\r`)
      } catch {
        // Ignore polling errors
      }
    }, 10_000)
  }

  // Run load
  const config: ScenarioConfig = {
    host: opts.host,
    port: opts.port,
    metricsUrl: opts.metricsUrl,
    vus,
    durationSeconds: duration,
    profile: opts.profile,
    loop: true,
  }

  await run(config)
  if (pollTimer) clearInterval(pollTimer)

  const endUnix = Math.floor(Date.now() / 1000)
  console.log('')

  // Get memory time-series
  let samples: MemorySoakResult['samples']
  let source: MemorySoakResult['source']

  if (useVM) {
    // Wait for VictoriaMetrics to flush the last scrape interval
    console.log('  Waiting for VictoriaMetrics to ingest final samples...')
    await new Promise((r) => setTimeout(r, 10_000))
    const points = await queryRange(METRIC_KEYS.processMemory, startUnix, endUnix)
    samples = points.map((p) => ({
      elapsedSeconds: Math.round(p.timestamp - startUnix),
      memoryMB: p.value / 1024 / 1024,
    }))
    source = 'victoriametrics'
  } else {
    samples = pollSamples
    source = 'polling'
  }

  if (samples.length === 0) {
    console.log('  No memory samples collected')
    return {
      durationSeconds: duration,
      samples: [],
      startMemoryMB: 0,
      endMemoryMB: 0,
      peakMemoryMB: 0,
      slopeMBPerMinute: 0,
      likelyLeak: false,
      source,
    }
  }

  const startMemory = samples[0].memoryMB
  const endMemory = samples[samples.length - 1].memoryMB
  const peakMemory = Math.max(...samples.map((s) => s.memoryMB))

  // Linear regression on post-warmup samples
  const postWarmup = samples.filter((s) => s.elapsedSeconds >= WARMUP_SECONDS)
  const slope = linearRegressionSlope(postWarmup)
  const slopeMBPerMin = slope * 60

  console.log('\n--- Summary ---')
  console.log(
    `  Duration: ${duration}s | Samples: ${samples.length} (${postWarmup.length} post-warmup)`,
  )
  console.log(`  Source: ${source}`)
  console.log(
    `  Start: ${startMemory.toFixed(1)}MB | End: ${endMemory.toFixed(1)}MB | Peak: ${peakMemory.toFixed(1)}MB`,
  )
  console.log(`  Growth: ${(endMemory - startMemory).toFixed(1)}MB`)
  console.log(`  Slope: ${slopeMBPerMin.toFixed(3)} MB/min`)
  console.log(`  Likely leak: ${Math.abs(slopeMBPerMin) > 0.5 ? 'YES' : 'no'}`)

  return {
    durationSeconds: duration,
    samples,
    startMemoryMB: startMemory,
    endMemoryMB: endMemory,
    peakMemoryMB: peakMemory,
    slopeMBPerMinute: slopeMBPerMin,
    likelyLeak: Math.abs(slopeMBPerMin) > 0.5,
    source,
  }
}

/** Linear regression slope (y = MB, x = elapsed seconds). Returns MB/second. */
function linearRegressionSlope(
  samples: Array<{ elapsedSeconds: number; memoryMB: number }>,
): number {
  if (samples.length < 2) return 0

  const n = samples.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumX2 = 0

  for (const s of samples) {
    sumX += s.elapsedSeconds
    sumY += s.memoryMB
    sumXY += s.elapsedSeconds * s.memoryMB
    sumX2 += s.elapsedSeconds * s.elapsedSeconds
  }

  const denominator = n * sumX2 - sumX * sumX
  if (denominator === 0) return 0
  return (n * sumXY - sumX * sumY) / denominator
}
