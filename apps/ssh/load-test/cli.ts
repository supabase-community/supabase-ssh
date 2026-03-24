import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionProfile } from './profiles/types.js'
import { startServer, ensureVictoriaMetrics, presets, type RunningServer } from './docker.js'

const TIER1_SCENARIOS = new Set([
  'latency-under-load',
  'idle-pressure',
  'memory-soak',
  'expensive-commands',
  'session-churn',
])

const SCENARIOS = {
  // Tier 1: Discovery
  'latency-under-load': () => import('./scenarios/latency-under-load.js'),
  'idle-pressure': () => import('./scenarios/idle-pressure.js'),
  'memory-soak': () => import('./scenarios/memory-soak.js'),
  'expensive-commands': () => import('./scenarios/expensive-commands.js'),
  'session-churn': () => import('./scenarios/session-churn.js'),
  // Autoscale
  'gradual-ramp': () => import('./scenarios/gradual-ramp.js'),
  // Tier 3: Validation
  'connection-ramp': () => import('./scenarios/connection-ramp.js'),
  'per-ip-concurrency': () => import('./scenarios/per-ip-concurrency.js'),
  'rate-limit': () => import('./scenarios/rate-limit.js'),
  'steady-state': () => import('./scenarios/steady-state.js'),
  'graceful-shutdown': () => import('./scenarios/graceful-shutdown.js'),
} as const

type ScenarioName = keyof typeof SCENARIOS

function loadProfile(profilePath?: string): SessionProfile {
  const path = profilePath ?? resolve(import.meta.dirname, 'profiles/captured-agent.json')
  const content = readFileSync(path, 'utf-8')
  return JSON.parse(content)
}

function printUsage() {
  console.log(`
Usage: pnpm tsx load-test/cli.ts <scenario> [options]

Scenarios:
  Tier 1 - Discovery (no limits, find breaking points):
    latency-under-load    Step ramp to find latency cliff
    idle-pressure         Memory per connection, max idle count
    memory-soak           Long duration memory leak detection
    expensive-commands    CPU contention ceiling
    session-churn         Connection setup/teardown limits

  Autoscale:
    gradual-ramp          Linear ramp simulating real traffic growth

  Tier 3 - Validation (limits enabled):
    connection-ramp       Soft/hard rejection curve
    per-ip-concurrency    Per-IP limit enforcement
    rate-limit            Sliding window accuracy (requires Redis)
    steady-state          Sustained load at operating point
    graceful-shutdown     Drain during active load

Options:
  --host <host>         Target host (default: 127.0.0.1)
  --port <port>         Target SSH port (default: 2222)
  --metrics <url>       Metrics URL (default: http://localhost:9091)
  --profile <path>      Session profile JSON path
  --vus <n>             Override virtual user count
  --duration <s>        Override duration in seconds
  --docker              Spawn server in Docker (auto-configured per tier)
  --memory <limit>      Docker memory limit, e.g., 256m, 512m, 1g (implies --docker)
  --cpus <n>            Docker CPU limit, e.g., 1, 0.5, 2 (implies --docker)
  --env <K=V>           Extra env var for Docker container (repeatable, implies --docker)
  --json                Output results as JSON
`)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '2222' },
      metrics: { type: 'string', default: 'http://localhost:9091' },
      profile: { type: 'string' },
      vus: { type: 'string' },
      duration: { type: 'string' },
      docker: { type: 'boolean', default: false },
      memory: { type: 'string' },
      cpus: { type: 'string' },
      env: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help || positionals.length === 0) {
    printUsage()
    process.exit(0)
  }

  const scenarioName = positionals[0] as ScenarioName
  if (!(scenarioName in SCENARIOS)) {
    console.error(`Unknown scenario: ${scenarioName}`)
    printUsage()
    process.exit(1)
  }

  const profile = loadProfile(values.profile)
  const vus = values.vus ? parseInt(values.vus, 10) : undefined
  const duration = values.duration ? parseInt(values.duration, 10) : undefined
  const useDocker = values.docker || !!values.memory || !!values.cpus || (values.env?.length ?? 0) > 0

  let server: RunningServer | null = null
  let host = values.host!
  let port = parseInt(values.port!, 10)
  let metricsUrl = values.metrics!

  if (useDocker) {
    // Parse extra env vars from --env K=V
    const extraEnv: Record<string, string> = {}
    for (const pair of values.env ?? []) {
      const eq = pair.indexOf('=')
      if (eq === -1) throw new Error(`Invalid --env format: ${pair} (expected K=V)`)
      extraEnv[pair.slice(0, eq)] = pair.slice(eq + 1)
    }

    // Pick preset based on tier
    const isDiscovery = TIER1_SCENARIOS.has(scenarioName)
    const preset = isDiscovery
      ? presets.discovery(values.memory, values.cpus)
      : presets.validation(extraEnv)

    // Merge extra env on top of preset
    if (isDiscovery && Object.keys(extraEnv).length > 0) {
      Object.assign(preset.env!, extraEnv)
    }
    if (!isDiscovery && values.memory) {
      preset.memory = values.memory
    }
    if (!isDiscovery && values.cpus) {
      preset.cpus = values.cpus
    }

    const constraints = [values.memory ? `${values.memory} RAM` : '', values.cpus ? `${values.cpus} CPU` : ''].filter(Boolean).join(', ')
    console.log(`\nStarting Docker server (${isDiscovery ? 'discovery' : 'validation'} preset${constraints ? `, ${constraints}` : ''})...`)
    await ensureVictoriaMetrics()
    server = await startServer(preset)
    host = '127.0.0.1'
    port = server.sshPort
    metricsUrl = server.metricsUrl
  }

  console.log(`\nLoad Test: ${scenarioName}`)
  console.log(`Target: ${host}:${port} | Metrics: ${metricsUrl}`)
  console.log(`Profile: ${profile.name}`)
  if (vus) console.log(`VUs: ${vus}`)
  if (duration) console.log(`Duration: ${duration}s`)

  try {
    const mod = await SCENARIOS[scenarioName]()

    switch (scenarioName) {
      case 'latency-under-load':
        await mod.execute({ host, port, metricsUrl, profile, ...(duration ? { stepDurationSeconds: duration } : {}) })
        break
      case 'idle-pressure':
        await mod.execute({ host, port, metricsUrl })
        break
      case 'memory-soak':
        await mod.execute({ host, port, metricsUrl, profile, vus, durationSeconds: duration })
        break
      case 'expensive-commands':
        await mod.execute({ host, port, metricsUrl, ...(duration ? { stepDurationSeconds: duration } : {}) })
        break
      case 'session-churn':
        await mod.execute({ host, port, metricsUrl, ...(duration ? { stepDurationSeconds: duration } : {}) })
        break
      case 'gradual-ramp':
        await mod.execute({ host, port, metricsUrl, profile, targetVUs: vus, holdSeconds: duration })
        break
      case 'connection-ramp':
        await mod.execute({ host, port, metricsUrl })
        break
      case 'per-ip-concurrency':
        await mod.execute({ host, port })
        break
      case 'rate-limit':
        await mod.execute({ host, port })
        break
      case 'steady-state':
        await mod.execute({ host, port, metricsUrl, profile, vus, durationSeconds: duration })
        break
      case 'graceful-shutdown':
        await mod.execute({ vus, warmupSeconds: duration })
        break
    }
  } finally {
    if (server) {
      console.log('\nStopping Docker server...')
      await server.stop()
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
