import type { AddressInfo } from 'node:net'
import { posix } from 'node:path'
import type { Span } from '@opentelemetry/api'
import { Chalk } from 'chalk'
import ssh2, { type ServerChannel } from 'ssh2'

import {
  decConnections,
  incCommands,
  incCommandTimeouts,
  incConnectionRejections,
  incConnections,
  observeCommandDuration,
  observeSessionDuration,
} from './metrics.js'
import { createBash } from './shell/bash.js'
import { createShellSession } from './shell/session.js'
import {
  createSessionContext,
  endCommandSpan,
  recordConnectionRejected,
  startCommandSpan,
} from './telemetry.js'

const { Server } = ssh2

// Force truecolor - output goes to SSH channels, not stdout
const chalk = new Chalk({ level: 3 })
const green = chalk.rgb(62, 207, 142)

const LOGO =
  ' ____                    _                    \r\n' +
  '/ ___| _   _ _ __   __ _| |__   __ _ ___  ___ \r\n' +
  "\\___ \\| | | | '_ \\ /  ` | '_ \\ / _` / __|/ _ \\\r\n" +
  ' ___) | |_| | |_) | (_| | |_) | (_| \\__ \\  __/\r\n' +
  '|____/ \\__,_| .__/ \\__,_|_.__/ \\__,_|___/\\___|\r\n' +
  '            |_|'

const bg = chalk.bgRgb(50, 50, 50)
const pad = '                                         '

const BANNER =
  `\r\n${green(LOGO)}\r\n` +
  `\r\nTell your agent to use ${chalk.dim('ssh supabase.sh <command>')} to search the docs:\r\n` +
  `\r\n${bg(pad)}\r\n` +
  `${bg(`  ${chalk.dim(`# Add to AGENTS.md (or CLAUDE.md)`)}      `)}\r\n` +
  `${bg(`  $ ssh supabase.sh agents >> AGENTS.md  `)}\r\n` +
  `${bg(pad)}\r\n\r\n` +
  `Or explore them yourself with tree/grep/cat/etc:\r\n\r\n`

export interface SSHServerOptions {
  /** PEM-encoded private key for the SSH server. */
  hostKey: Buffer
  /** SSH listen port. */
  port?: number
  /** Disconnect after this many ms of inactivity. */
  idleTimeout?: number
  /** Max session duration in ms, regardless of activity. */
  sessionTimeout?: number
  /** Per-command execution timeout in ms. */
  execTimeout?: number
  /** Connections above this start getting probabilistically dropped (linear ramp). */
  softLimit?: number
  /** All connections above this are rejected. */
  hardLimit?: number
  /** Root directory for docs content. */
  docsDir?: string
}

/** Creates a testable SSH server. Call listen() to start, close() to stop. */
export function createSSHServer(opts: SSHServerOptions) {
  const {
    hostKey,
    port = 22,
    idleTimeout = 30_000,
    sessionTimeout = 600_000,
    execTimeout = 10_000,
    softLimit = 80,
    hardLimit = 100,
    docsDir,
  } = opts

  const activeClients = new Map<ssh2.Connection, Set<ServerChannel>>()
  let isShuttingDown = false

  const server = new Server(
    {
      hostKeys: [hostKey],
      algorithms: {
        kex: [
          'curve25519-sha256',
          'curve25519-sha256@libssh.org',
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
        ],
      },
    },
    (client, info) => {
      const channels = new Set<ServerChannel>()
      activeClients.set(client, channels)

      const sessionCtx = createSessionContext(info)
      const sessionStartTime = Date.now()
      let sessionMode: 'exec' | 'shell' = 'exec'
      let endReason = 'user_exit'

      if (activeClients.size >= softLimit) {
        const dropProbability =
          activeClients.size >= hardLimit
            ? 1
            : (activeClients.size - softLimit) / (hardLimit - softLimit)

        if (Math.random() < dropProbability) {
          console.warn(
            `Rejecting connection: ${activeClients.size} active (soft=${softLimit} hard=${hardLimit} p=${dropProbability.toFixed(2)})`
          )
          recordConnectionRejected(sessionCtx, activeClients.size, dropProbability)
          incConnectionRejections()
          activeClients.delete(client)
          client.end()
          return
        }
      }

      let activeChannel: ServerChannel | null = null

      const endSession = (reason: string) => {
        console.log(`Client ${reason}, disconnecting`)
        endReason = reason === 'idle timeout' ? 'idle_timeout' : 'max_timeout'
        if (activeChannel) {
          activeChannel.stderr.write(
            `\r\n\r\n${green('Session timed out. Reconnect by running: ssh supabase.sh')}\r\n\r\n`
          )
        }
        setTimeout(() => client.end(), 500)
      }

      const idleTimer = setTimeout(() => endSession('idle timeout'), idleTimeout)
      const sessionTimer = setTimeout(() => endSession('max session reached'), sessionTimeout)
      const resetIdle = () => {
        idleTimer.refresh()
      }

      client.on('authentication', (ctx) => ctx.accept())

      client.on('handshake', (negotiated) => {
        sessionCtx.negotiatedKex = negotiated.kex
        sessionCtx.negotiatedCipher = negotiated.cs.cipher
      })

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()

          let hasPty = false
          session.on('pty', (accept) => {
            hasPty = true
            sessionCtx.hasPty = true
            accept()
          })

          session.on('exec', async (accept, _reject, execInfo) => {
            sessionCtx.mode = 'exec'
            sessionMode = 'exec'
            incConnections('exec')
            resetIdle()
            const channel = accept()
            channels.add(channel)
            channel.on('close', () => channels.delete(channel))
            const command = execInfo.command
            console.log(`exec: ${command}`)

            const cmdStart = Date.now()
            const cmdSpan = startCommandSpan(sessionCtx, command)
            try {
              const bash = await createBash(docsDir)
              const result = await bash.exec(command, { signal: AbortSignal.timeout(execTimeout) })
              if (result.stdout) channel.write(result.stdout)
              if (result.stderr) channel.stderr.write(result.stderr)
              channel.exit(result.exitCode)
              const exitCode = result.exitCode ?? 0
              observeCommandDuration((Date.now() - cmdStart) / 1000)
              incCommands(command, exitCode)
              endCommandSpan(cmdSpan, {
                exitCode,
                stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
                stderrBytes: Buffer.byteLength(result.stderr ?? ''),
                timedOut: false,
              })
            } catch (err) {
              const timedOut = err instanceof Error && err.name === 'TimeoutError'
              channel.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
              channel.exit(1)
              observeCommandDuration((Date.now() - cmdStart) / 1000)
              incCommands(command, 1)
              if (timedOut) incCommandTimeouts()
              endCommandSpan(cmdSpan, {
                exitCode: 1,
                stdoutBytes: 0,
                stderrBytes: 0,
                timedOut,
              })
            }

            channel.end()
          })

          session.on('shell', async (accept) => {
            sessionCtx.mode = 'shell'
            sessionMode = 'shell'
            incConnections('shell')
            const channel = accept()
            activeChannel = channel
            channels.add(channel)
            channel.on('close', () => channels.delete(channel))

            channel.on('data', () => resetIdle())

            let activeSpan: Span | null = null
            const bash = await createBash(docsDir)
            const shell = createShellSession({
              bash,
              input: channel,
              output: channel,
              terminal: hasPty,
              execTimeout,
              banner: BANNER,
              prompt: (cwd) => `${green(posix.basename(cwd))} $ `,
              beforeExec: (command) => {
                if (command === 'exit') {
                  channel.write(`\r\n${green('Thanks for stopping by!')}\r\n\r\n`)
                  shell.close()
                  channel.end()
                  return false
                }
                if (command) {
                  activeSpan = startCommandSpan(sessionCtx, command)
                }
              },
              afterExec: (cmdInfo) => {
                incCommands(cmdInfo.command ?? 'unknown', cmdInfo.exitCode)
                observeCommandDuration(cmdInfo.durationMs / 1000)
                if (cmdInfo.timedOut) incCommandTimeouts()
                if (activeSpan) {
                  endCommandSpan(activeSpan, {
                    exitCode: cmdInfo.exitCode,
                    stdoutBytes: cmdInfo.stdoutBytes,
                    stderrBytes: cmdInfo.stderrBytes,
                    timedOut: cmdInfo.timedOut,
                  })
                  activeSpan = null
                }
              },
              onExit: () => channel.end(),
            })
          })
        })
      })

      client.on('end', () => {
        clearTimeout(idleTimer)
        clearTimeout(sessionTimer)
        activeClients.delete(client)
        decConnections()
        const reason = isShuttingDown ? 'server_shutdown' : endReason
        observeSessionDuration((Date.now() - sessionStartTime) / 1000, sessionMode, reason)
      })
      client.on('error', (err) => console.error('Client error:', err.message))
    }
  )

  return {
    server,

    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(port, '0.0.0.0', () => {
          const addr = server.address() as AddressInfo
          console.log(`SSH server listening on port ${addr.port}`)
          console.log('Connect: ssh localhost')
          resolve(addr.port)
        })
      })
    },

    async close(message?: string, drainTimeout = 15_000): Promise<void> {
      isShuttingDown = true

      // 1. Stop accepting new connections
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })

      if (activeClients.size > 0) {
        // 2. Wait for in-flight commands to finish naturally
        const drained = new Promise<void>((resolve) => {
          const check = () => {
            if (activeClients.size === 0) resolve()
          }
          for (const [c] of activeClients) {
            c.on('end', check)
          }
        })

        const timedOut = await Promise.race([
          drained.then(() => false),
          new Promise<true>((resolve) => setTimeout(() => resolve(true), drainTimeout)),
        ])

        // 3. If drain timed out, notify and force-disconnect remaining sessions
        if (timedOut) {
          for (const [c, channels] of activeClients) {
            for (const channel of channels) {
              if (message) channel.stderr.end(message)
              channel.exit(255)
            }
            c.end()
          }
        }
      }

      await serverClosed
    },
  }
}
