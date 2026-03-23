import { generateKeyPairSync } from 'node:crypto'
import { Client } from 'ssh2'
import { connect, exec, type ConnectedClient } from './ssh-client.js'
import { scrapeMetrics, scrapeHealth, computeDeltas, type MetricsSnapshot } from './metrics-collector.js'
import type { SessionProfile } from './profiles/types.js'

export interface ScenarioConfig {
  /** Target SSH host */
  host: string
  /** Target SSH port */
  port: number
  /** Metrics endpoint URL (e.g., http://localhost:9091) */
  metricsUrl?: string
  /** Number of virtual users */
  vus: number
  /** Test duration in seconds */
  durationSeconds: number
  /** Ramp-up time in seconds (0 = all VUs start at once) */
  rampUpSeconds?: number
  /** Session profile to replay */
  profile: SessionProfile
  /** Loop the profile for the test duration */
  loop?: boolean
  /** Callback for periodic progress updates */
  onProgress?: (stats: LiveStats) => void
  /** Progress update interval in ms (default 5000) */
  progressIntervalMs?: number
}

export interface LiveStats {
  elapsedSeconds: number
  activeVUs: number
  totalConnections: number
  totalCommands: number
  totalErrors: number
  totalRejections: number
}

export interface ScenarioResult {
  totalConnections: number
  successfulConnections: number
  totalCommands: number
  /** Commands that completed (any exit code) */
  completedCommands: number
  /** SSH-level failures: connection drops, channel errors */
  serverErrors: number
  /** Commands that returned non-zero exit code (normal for grep, etc.) */
  nonZeroExits: number
  rejections: { capacity: number; rateLimit: number; concurrency: number }
  connectLatency: LatencyStats
  commandLatency: LatencyStats
  commandsPerSecond: number
  durationSeconds: number
  metricsBefore?: MetricsSnapshot
  metricsAfter?: MetricsSnapshot
  metricDeltas?: Record<string, number>
}

export interface LatencyStats {
  p50: number
  p95: number
  p99: number
  max: number
  min: number
  count: number
}

function computeLatency(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0, min: 0, count: 0 }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
    min: sorted[0],
    count: sorted.length,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run a single VU: connect, replay profile commands, disconnect */
async function runVU(
  config: ScenarioConfig,
  collectors: {
    connectTimes: number[]
    commandTimes: number[]
    serverErrors: number
    nonZeroExits: number
    timeouts: number
    rejections: { capacity: number; rateLimit: number; concurrency: number }
    connections: number
    commands: number
  },
  stopSignal: { stopped: boolean },
  activeClients: Set<Client>
): Promise<void> {
  while (!stopSignal.stopped) {
    let connected: ConnectedClient | null = null
    try {
      connected = await connect({
        host: config.host,
        port: config.port,
      })
      collectors.connections++

      if (connected.rejected) {
        const type = connected.rejectionType
        if (type === 'capacity') collectors.rejections.capacity++
        else if (type === 'rate_limit') collectors.rejections.rateLimit++
        else if (type === 'concurrency') collectors.rejections.concurrency++
        await sleep(1000)
        continue
      }

      activeClients.add(connected.client)
      collectors.connectTimes.push(connected.connectTimeMs)

      // Replay profile commands (offsets are ms from session start)
      const vuStart = performance.now()
      for (const cmd of config.profile.commands) {
        if (stopSignal.stopped) break

        const elapsed = performance.now() - vuStart
        const wait = cmd.offset - elapsed
        if (wait > 0) {
          await sleep(wait)
        }
        if (stopSignal.stopped) break

        try {
          const result = await exec(connected.client, cmd.command)
          collectors.commands++
          if (result.timedOut) {
            collectors.timeouts++
          } else {
            collectors.commandTimes.push(result.commandTimeMs)
            if (result.exitCode !== 0) {
              collectors.nonZeroExits++
            }
          }
        } catch {
          collectors.serverErrors++
        }
      }
    } catch {
      // Connection error - count and retry
      collectors.serverErrors++
      await sleep(500)
    } finally {
      if (connected?.client) {
        activeClients.delete(connected.client)
        connected.client.end()
        connected.client.destroy()
      }
    }

    if (!config.loop) break
  }
}

/** Run a load test scenario */
export async function run(config: ScenarioConfig): Promise<ScenarioResult> {
  const { vus, durationSeconds, rampUpSeconds = 0, metricsUrl } = config
  const stopSignal = { stopped: false }

  // Track active clients for force cleanup
  const activeClients = new Set<Client>()

  // Shared collectors across all VUs
  const collectors = {
    connectTimes: [] as number[],
    commandTimes: [] as number[],
    serverErrors: 0,
    nonZeroExits: 0,
    timeouts: 0,
    rejections: { capacity: 0, rateLimit: 0, concurrency: 0 },
    connections: 0,
    commands: 0,
  }

  // Scrape metrics before
  let metricsBefore: MetricsSnapshot | undefined
  if (metricsUrl) {
    try {
      metricsBefore = await scrapeMetrics(metricsUrl)
    } catch {
      // Metrics endpoint not available
    }
  }

  const startTime = performance.now()

  // Progress reporting
  let progressTimer: ReturnType<typeof setInterval> | undefined
  if (config.onProgress) {
    const interval = config.progressIntervalMs ?? 5000
    progressTimer = setInterval(() => {
      config.onProgress!({
        elapsedSeconds: Math.round((performance.now() - startTime) / 1000),
        activeVUs: vuPromises.length,
        totalConnections: collectors.connections,
        totalCommands: collectors.commands,
        totalErrors: collectors.serverErrors,
        totalRejections:
          collectors.rejections.capacity +
          collectors.rejections.rateLimit +
          collectors.rejections.concurrency,
      })
    }, interval)
  }

  // Launch VUs with optional ramp-up
  const vuPromises: Promise<void>[] = []
  const rampDelayMs = rampUpSeconds > 0 ? (rampUpSeconds * 1000) / vus : 0

  for (let i = 0; i < vus; i++) {
    vuPromises.push(runVU(config, collectors, stopSignal, activeClients))
    if (rampDelayMs > 0 && i < vus - 1) {
      await sleep(rampDelayMs)
    }
  }

  // Wait for duration
  const remainingMs = durationSeconds * 1000 - (performance.now() - startTime)
  if (remainingMs > 0) {
    await sleep(remainingMs)
  }

  // Signal VUs to stop
  stopSignal.stopped = true

  // Wait for in-flight VUs to finish, then force-destroy stragglers
  await Promise.race([
    Promise.allSettled(vuPromises),
    sleep(10_000), // 10s grace period
  ])

  // Force-destroy any connections still open after grace period
  activeClients.forEach((client) => client.destroy())
  activeClients.clear()

  if (progressTimer) clearInterval(progressTimer)

  const elapsed = (performance.now() - startTime) / 1000

  // Scrape metrics after
  let metricsAfter: MetricsSnapshot | undefined
  let metricDeltas: Record<string, number> | undefined
  if (metricsUrl) {
    try {
      metricsAfter = await scrapeMetrics(metricsUrl)
      if (metricsBefore) {
        metricDeltas = computeDeltas(metricsBefore, metricsAfter)
      }
    } catch {
      // Metrics endpoint not available
    }
  }

  return {
    totalConnections: collectors.connections,
    successfulConnections: collectors.connectTimes.length,
    totalCommands: collectors.commands,
    completedCommands: collectors.commands - collectors.serverErrors,
    serverErrors: collectors.serverErrors,
    nonZeroExits: collectors.nonZeroExits,
    rejections: { ...collectors.rejections },
    connectLatency: computeLatency(collectors.connectTimes),
    commandLatency: computeLatency(collectors.commandTimes),
    commandsPerSecond: collectors.commands / elapsed,
    durationSeconds: elapsed,
    metricsBefore,
    metricsAfter,
    metricDeltas,
  }
}

/** Generate an RSA host key for local test servers */
export function generateHostKey(): Buffer {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  }) as string
  return Buffer.from(key)
}
