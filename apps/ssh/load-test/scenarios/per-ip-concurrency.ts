import { type ConnectedClient, connect } from '../ssh-client.js'

export const description = 'Verify per-IP concurrent connection limit enforcement'

export interface PerIpConcurrencyResult {
  limit: number
  successfulConnections: number
  rejectedConnections: number
  rejectionMessages: string[]
  reconnectAfterDisconnect: boolean
}

/**
 * Open connections beyond the per-IP limit and verify enforcement.
 * Then verify that after disconnecting some, new connections succeed.
 */
export async function execute(opts: {
  host: string
  port: number
  /** Expected per-IP limit (default 10) */
  expectedLimit?: number
}): Promise<PerIpConcurrencyResult> {
  const expectedLimit = opts.expectedLimit ?? 10
  const attemptCount = Math.ceil(expectedLimit * 1.5)

  console.log(
    `\nPer-IP Concurrency - attempting ${attemptCount} connections (limit: ${expectedLimit})\n`,
  )

  const clients: ConnectedClient[] = []
  let rejectedCount = 0
  const rejectionMessages: string[] = []

  // Open connections beyond the limit
  for (let i = 0; i < attemptCount; i++) {
    try {
      const connected = await connect({ host: opts.host, port: opts.port })
      if (connected.rejected) {
        rejectedCount++
        if (connected.rejectionMessage) {
          rejectionMessages.push(connected.rejectionMessage)
        }
        console.log(`  Connection ${i + 1}: REJECTED (${connected.rejectionType})`)
      } else {
        clients.push(connected)
        console.log(`  Connection ${i + 1}: OK`)
      }
    } catch (err) {
      rejectedCount++
      console.log(`  Connection ${i + 1}: ERROR - ${err}`)
    }
  }

  console.log(`\n  ${clients.length} connected, ${rejectedCount} rejected`)

  // Verify reconnect after disconnect
  let reconnectOk = false
  if (clients.length > 0) {
    console.log('\n  Disconnecting 1 client...')
    const removed = clients.pop()
    removed?.client.end()
    removed?.client.destroy()
    await new Promise((resolve) => setTimeout(resolve, 500))

    console.log('  Attempting reconnect...')
    try {
      const reconnected = await connect({ host: opts.host, port: opts.port })
      if (!reconnected.rejected) {
        reconnectOk = true
        console.log('  Reconnect: OK')
        reconnected.client.end()
        reconnected.client.destroy()
      } else {
        console.log(`  Reconnect: REJECTED (${reconnected.rejectionType})`)
      }
    } catch {
      console.log('  Reconnect: ERROR')
    }
  }

  // Cleanup
  for (const c of clients) {
    c.client.end()
    c.client.destroy()
  }

  console.log('\n--- Summary ---')
  console.log(`  Expected limit: ${expectedLimit}`)
  console.log(`  Successful connections: ${clients.length + (reconnectOk ? 1 : 0)}`)
  console.log(`  Rejected connections: ${rejectedCount}`)
  console.log(`  Reconnect after disconnect: ${reconnectOk ? 'OK' : 'FAILED'}`)

  const pass = clients.length <= expectedLimit && rejectedCount > 0 && reconnectOk
  console.log(`\nResult: ${pass ? 'PASS' : 'FAIL'}`)

  return {
    limit: expectedLimit,
    successfulConnections: clients.length,
    rejectedConnections: rejectedCount,
    rejectionMessages,
    reconnectAfterDisconnect: reconnectOk,
  }
}
