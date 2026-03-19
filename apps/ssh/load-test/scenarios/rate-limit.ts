import { connect, exec } from '../ssh-client.js'

export const description = 'Verify Redis-backed sliding window rate limit accuracy'

export interface RateLimitResult {
  windowSeconds: number
  maxPerWindow: number
  successfulInWindow: number
  rejectedInWindow: number
  recoveredAfterWindow: boolean
}

/**
 * Rapid connect/exec/disconnect in a tight loop to exhaust the rate limit window.
 * Verify that exactly N connections succeed per window, then recover.
 */
export async function execute(opts: {
  host: string
  port: number
  /** Expected rate limit max per window (default 30) */
  expectedMax?: number
  /** Expected window size in seconds (default 60) */
  expectedWindowSeconds?: number
}): Promise<RateLimitResult> {
  const maxPerWindow = opts.expectedMax ?? 30
  const windowSeconds = opts.expectedWindowSeconds ?? 60
  const attempts = Math.ceil(maxPerWindow * 1.5)

  console.log(`\nRate Limit - ${attempts} rapid connections (limit: ${maxPerWindow}/${windowSeconds}s)\n`)

  let successful = 0
  let rejected = 0

  // Exhaust the window
  for (let i = 0; i < attempts; i++) {
    try {
      const connected = await connect({ host: opts.host, port: opts.port, timeout: 3000 })
      if (connected.rejected) {
        if (connected.rejectionType === 'rate_limit') {
          rejected++
          console.log(`  Connection ${i + 1}: RATE LIMITED - ${connected.rejectionMessage}`)
        } else {
          // Other rejection types don't count
          console.log(`  Connection ${i + 1}: REJECTED (${connected.rejectionType})`)
        }
      } else {
        successful++
        // Quick exec + disconnect
        try {
          await exec(connected.client, 'echo ok')
        } catch {
          // Ignore exec errors
        }
        connected.client.end()
        connected.client.destroy()
        if (successful % 10 === 0) console.log(`  ${successful} successful so far...`)
      }
    } catch {
      console.log(`  Connection ${i + 1}: ERROR`)
    }
  }

  console.log(`\n  Window result: ${successful} successful, ${rejected} rate-limited`)

  // Wait for window to reset and try again
  console.log(`\n  Waiting ${windowSeconds}s for window reset...`)
  await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000))

  let recoveredAfterWindow = false
  try {
    const connected = await connect({ host: opts.host, port: opts.port, timeout: 3000 })
    if (!connected.rejected) {
      recoveredAfterWindow = true
      connected.client.end()
      connected.client.destroy()
      console.log('  Post-window connection: OK')
    } else {
      console.log(`  Post-window connection: REJECTED (${connected.rejectionType})`)
    }
  } catch {
    console.log('  Post-window connection: ERROR')
  }

  console.log('\n--- Summary ---')
  console.log(`  Expected limit: ${maxPerWindow} per ${windowSeconds}s`)
  console.log(`  Successful in window: ${successful}`)
  console.log(`  Rate-limited in window: ${rejected}`)
  console.log(`  Recovered after window: ${recoveredAfterWindow}`)

  const pass = successful <= maxPerWindow && rejected > 0 && recoveredAfterWindow
  console.log(`\nResult: ${pass ? 'PASS' : 'FAIL'}`)

  return {
    windowSeconds,
    maxPerWindow,
    successfulInWindow: successful,
    rejectedInWindow: rejected,
    recoveredAfterWindow,
  }
}
