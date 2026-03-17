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
  hostKey: Buffer
  port?: number
  idleTimeout?: number
  maxSessionTimeout?: number
  maxConnections?: number
  execTimeout?: number
  docsDir?: string
}

const RSS_LIMIT = 512 * 1024 * 1024
const MEMORY_WARN_THRESHOLD = 0.85

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function logStats(event: string, activeConnections: number, totalConnections: number) {
  const mem = process.memoryUsage()
  console.log(
    `[stats] ${event} | active=${activeConnections} total=${totalConnections}` +
      ` | rss=${mb(mem.rss)}/${mb(RSS_LIMIT)} heap=${mb(mem.heapUsed)} external=${mb(mem.external)}`
  )
  if (mem.rss / RSS_LIMIT > MEMORY_WARN_THRESHOLD) {
    console.warn(
      `[oom-warning] rss at ${((mem.rss / RSS_LIMIT) * 100).toFixed(0)}% ` +
        `(${mb(mem.rss)}/${mb(RSS_LIMIT)}) - active=${activeConnections}`
    )
  }
}

/** Creates a testable SSH server. Call listen() to start, close() to stop. */
export function createSSHServer(opts: SSHServerOptions) {
  const {
    hostKey,
    port = 22,
    idleTimeout = 30_000,
    maxSessionTimeout = 600_000,
    maxConnections = 100,
    execTimeout = 10_000,
    docsDir,
  } = opts

  const activeChannels = new Set<ServerChannel>()
  let totalConnections = 0
  let activeConnections = 0
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
      totalConnections++
      activeConnections++
      logStats('connect', activeConnections, totalConnections)

      const sessionCtx = createSessionContext(info)
      const sessionStartTime = Date.now()
      let sessionMode: 'exec' | 'shell' = 'exec'
      let endReason = 'user_exit'

      if (activeConnections > maxConnections) {
        console.log(`Rejecting connection: ${activeConnections}/${maxConnections}`)
        recordConnectionRejected(sessionCtx.clientSoftware, activeConnections)
        incConnectionRejections()
        activeConnections--
        client.end()
        return
      }

      let activeChannel: ServerChannel | null = null

      const endSession = (reason: string) => {
        console.log(`Client ${reason}, disconnecting`)
        endReason = reason === 'idle timeout' ? 'idle_timeout' : 'max_timeout'
        if (activeChannel) {
          activeChannel.write(
            `\r\n\r\n${green('Session timed out. Reconnect by running: ssh supabase.sh')}\r\n\r\n`
          )
        }
        setTimeout(() => client.end(), 500)
      }

      const idleTimer = setTimeout(() => endSession('idle timeout'), idleTimeout)
      const sessionTimer = setTimeout(() => endSession('max session reached'), maxSessionTimeout)
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
            activeChannels.add(channel)
            channel.on('close', () => activeChannels.delete(channel))

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
        activeConnections--
        decConnections()
        const reason = isShuttingDown ? 'server_shutdown' : endReason
        observeSessionDuration((Date.now() - sessionStartTime) / 1000, sessionMode, reason)
        logStats('disconnect', activeConnections, totalConnections)
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

    close(message?: string): Promise<void> {
      isShuttingDown = true
      for (const channel of activeChannels) {
        if (message) channel.write(message)
        channel.end()
      }
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
