import type { Client } from 'ssh2'
import type { SessionProfile } from '../profiles/types.js'
import type { LatencyStats } from '../runner.js'
import { type ConnectedClient, connect, exec } from '../ssh-client.js'

export const description = 'Exponential spike simulating viral traffic (HN/Twitter)'

export interface ViralSpikeResult {
  peakRPS: number
  riseSeconds: number
  holdSeconds: number
  decaySeconds: number
  totalSessions: number
  commandLatency: LatencyStats
  connectLatency: LatencyStats
  commands: number
  errors: number
  rejections: number
  commandsPerSecond: number
  durationSeconds: number
  /** Per-second arrival rate log */
  arrivalLog: { second: number; launched: number; active: number }[]
}

/**
 * Compute per-second arrival rates for an exponential spike curve.
 *
 * Rise:  rate(t) = peakRPS * (e^(k*t/rise) - 1) / (e^k - 1)
 * Hold:  rate(t) = peakRPS
 * Decay: rate(t) = peakRPS * e^(-k*(t-decayStart)/decay)
 *
 * k controls steepness (higher = more aggressive curve)
 */
function buildArrivalSchedule(opts: {
  peakRPS: number
  riseSeconds: number
  holdSeconds: number
  decaySeconds: number
  steepness?: number
}): number[] {
  const { peakRPS, riseSeconds, holdSeconds, decaySeconds, steepness = 3 } = opts
  const schedule: number[] = []
  const k = steepness

  // Rise phase - exponential growth
  for (let t = 0; t < riseSeconds; t++) {
    const rate = peakRPS * (Math.exp((k * t) / riseSeconds) - 1) / (Math.exp(k) - 1)
    schedule.push(Math.max(1, Math.round(rate)))
  }

  // Hold phase - sustained peak
  for (let t = 0; t < holdSeconds; t++) {
    schedule.push(peakRPS)
  }

  // Decay phase - exponential decay
  for (let t = 0; t < decaySeconds; t++) {
    const rate = peakRPS * Math.exp((-k * t) / decaySeconds)
    schedule.push(Math.max(1, Math.round(rate)))
  }

  return schedule
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run a single session: replay profile commands with fresh SSH connections */
async function runSession(
  host: string,
  port: number,
  profile: SessionProfile,
  collectors: {
    connectTimes: number[]
    commandTimes: number[]
    serverErrors: number
    nonZeroExits: number
    rejections: { capacity: number; rateLimit: number; concurrency: number }
    commands: number
    errorSamples: { type: string; message: string }[]
  },
  activeCount: { value: number },
  activeClients: Set<Client>,
): Promise<void> {
  activeCount.value++
  try {
    const sessionStart = performance.now()
    for (const cmd of profile.commands) {
      const elapsed = performance.now() - sessionStart
      const wait = cmd.offset - elapsed
      if (wait > 0) await sleep(wait)

      let connected: ConnectedClient | null = null
      try {
        connected = await connect({ host, port })

        if (connected.rejected) {
          const type = connected.rejectionType
          if (type === 'capacity') collectors.rejections.capacity++
          else if (type === 'rate_limit') collectors.rejections.rateLimit++
          else if (type === 'concurrency') collectors.rejections.concurrency++
          continue
        }

        activeClients.add(connected.client)
        collectors.connectTimes.push(connected.connectTimeMs)

        try {
          const result = await exec(connected.client, cmd.command)
          collectors.commands++
          if (!result.timedOut) {
            collectors.commandTimes.push(result.commandTimeMs)
            if (result.exitCode !== 0) collectors.nonZeroExits++
          }
        } catch (err) {
          collectors.serverErrors++
          collectors.errorSamples.push({ type: 'exec', message: String(err) })
        }
      } catch (err) {
        collectors.serverErrors++
        collectors.errorSamples.push({ type: 'connect', message: String(err) })
      } finally {
        if (connected?.client) {
          activeClients.delete(connected.client)
          connected.client.end()
          connected.client.destroy()
        }
      }
    }
  } finally {
    activeCount.value--
  }
}

function computeLatency(samples: number[]): LatencyStats {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, min: 0, count: 0 }
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

/**
 * Simulate a viral traffic spike with exponential rise and decay.
 *
 * Default curve (peakRPS=50):
 *   0-60s:   exponential rise from ~1 to 50 RPS
 *   60-120s: hold at 50 RPS
 *   120-300s: exponential decay from 50 back to ~1 RPS
 */
export async function execute(opts: {
  host: string
  port: number
  profile: SessionProfile
  peakRPS?: number
  riseSeconds?: number
  holdSeconds?: number
  decaySeconds?: number
  steepness?: number
}): Promise<ViralSpikeResult> {
  const peakRPS = opts.peakRPS ?? 50
  const riseSeconds = opts.riseSeconds ?? 60
  const holdSeconds = opts.holdSeconds ?? 60
  const decaySeconds = opts.decaySeconds ?? 180
  const steepness = opts.steepness ?? 3

  const schedule = buildArrivalSchedule({ peakRPS, riseSeconds, holdSeconds, decaySeconds, steepness })
  const totalSessions = schedule.reduce((a, b) => a + b, 0)
  const totalSeconds = schedule.length

  console.log(`\nViral Spike - peak ${peakRPS} RPS`)
  console.log(`  Rise: 0 -> ${peakRPS} over ${riseSeconds}s (exponential, k=${steepness})`)
  console.log(`  Hold: ${peakRPS} RPS for ${holdSeconds}s`)
  console.log(`  Decay: ${peakRPS} -> ~1 over ${decaySeconds}s (exponential)`)
  console.log(`  Total sessions: ${totalSessions} over ${totalSeconds}s\n`)

  const collectors = {
    connectTimes: [] as number[],
    commandTimes: [] as number[],
    serverErrors: 0,
    nonZeroExits: 0,
    rejections: { capacity: 0, rateLimit: 0, concurrency: 0 },
    commands: 0,
    errorSamples: [] as { type: string; message: string }[],
  }

  const activeCount = { value: 0 }
  const activeClients = new Set<Client>()
  const sessionPromises: Promise<void>[] = []
  const arrivalLog: { second: number; launched: number; active: number }[] = []

  const startTime = performance.now()

  for (let second = 0; second < totalSeconds; second++) {
    const count = schedule[second]
    const secondStart = performance.now()

    // Spread launches evenly within this second
    const interval = 1000 / count
    for (let i = 0; i < count; i++) {
      const delay = i * interval
      const launchAt = secondStart + delay - performance.now()
      if (launchAt > 0) await sleep(launchAt)

      sessionPromises.push(
        runSession(opts.host, opts.port, opts.profile, collectors, activeCount, activeClients),
      )
    }

    const totalRejections =
      collectors.rejections.capacity +
      collectors.rejections.rateLimit +
      collectors.rejections.concurrency
    arrivalLog.push({ second, launched: count, active: activeCount.value })

    // Progress every 15s
    if (second % 15 === 0 || second === totalSeconds - 1) {
      const phase =
        second < riseSeconds ? 'RISE' : second < riseSeconds + holdSeconds ? 'HOLD' : 'DECAY'
      console.log(
        `  [${second}s ${phase}] rate=${count}/s active=${activeCount.value} cmds=${collectors.commands} errors=${collectors.serverErrors} rejections=${totalRejections}`,
      )
    }

    // Wait for the rest of this second
    const elapsed = performance.now() - secondStart
    if (elapsed < 1000) await sleep(1000 - elapsed)
  }

  // Wait for all in-flight sessions to complete (with timeout)
  console.log(`\nWaiting for ${activeCount.value} in-flight sessions to complete...`)
  await Promise.race([Promise.allSettled(sessionPromises), sleep(60_000)])

  // Force-destroy stragglers
  for (const client of activeClients) client.destroy()
  activeClients.clear()

  const durationSeconds = (performance.now() - startTime) / 1000
  const totalRejections =
    collectors.rejections.capacity +
    collectors.rejections.rateLimit +
    collectors.rejections.concurrency

  console.log('\n--- Summary ---')
  console.log(
    `Peak: ${peakRPS} RPS | Rise: ${riseSeconds}s | Hold: ${holdSeconds}s | Decay: ${decaySeconds}s`,
  )
  console.log(
    `p50=${computeLatency(collectors.commandTimes).p50.toFixed(0)}ms  p95=${computeLatency(collectors.commandTimes).p95.toFixed(0)}ms  p99=${computeLatency(collectors.commandTimes).p99.toFixed(0)}ms  max=${computeLatency(collectors.commandTimes).max.toFixed(0)}ms`,
  )
  console.log(
    `Sessions: ${totalSessions} | Commands: ${collectors.commands} (${(collectors.commands / durationSeconds).toFixed(1)}/s) | Errors: ${collectors.serverErrors} | Rejections: ${totalRejections}`,
  )

  // Deduplicate and print error samples
  const errorMap = new Map<string, { type: string; message: string; count: number }>()
  for (const sample of collectors.errorSamples) {
    const key = `${sample.type}:${sample.message.slice(0, 100)}`
    const existing = errorMap.get(key)
    if (existing) existing.count++
    else errorMap.set(key, { ...sample, count: 1 })
  }
  const errorSamples = [...errorMap.values()].sort((a, b) => b.count - a.count)
  if (errorSamples.length > 0) {
    console.log('\n--- Errors ---')
    for (const e of errorSamples.slice(0, 10)) {
      console.log(`  [${e.type}] x${e.count}: ${e.message.slice(0, 120)}`)
    }
  }

  return {
    peakRPS,
    riseSeconds,
    holdSeconds,
    decaySeconds,
    totalSessions,
    commandLatency: computeLatency(collectors.commandTimes),
    connectLatency: computeLatency(collectors.connectTimes),
    commands: collectors.commands,
    errors: collectors.serverErrors,
    rejections: totalRejections,
    commandsPerSecond: collectors.commands / durationSeconds,
    durationSeconds,
    arrivalLog,
  }
}
