import type { AddressInfo } from 'node:net'
import { posix } from 'node:path'
import type { Span } from '@opentelemetry/api'
import { Chalk } from 'chalk'
import ssh2, { type ServerChannel } from 'ssh2'
import { CommandCache, type CommandCacheOptions } from './command-cache.js'
import {
  decActiveConnections,
  incActiveConnections,
  incCommandCacheHit,
  incCommandCacheMiss,
  incCommands,
  incCommandTimeouts,
  incConcurrencyRejections,
  incConnectionRejections,
  incRateLimitRejections,
  incSessions,
  observeCommandDuration,
  observeSessionDuration,
} from './metrics.js'
import type { RateLimiter } from './ratelimit.js'
import { createBash } from './shell/bash.js'
import { createShellSession } from './shell/session.js'
import {
  createSessionContext,
  endCommandSpan,
  recordConcurrencyLimited,
  recordConnectionRejected,
  recordRateLimited,
  setReadPaths,
  shouldObserveFs,
  startCommandSpan,
} from './telemetry.js'

const { Server } = ssh2

/** ssh2 Protocol internals needed for sending raw packets. */
interface SSH2Protocol {
  _packetRW: {
    write: {
      allocStart: number
      alloc(size: number): Buffer
      finalize(packet: Buffer): Buffer
    }
  }
  _cipher: { encrypt(packet: Buffer): void }
}

/** Type guard for ssh2 AuthContext._protocol. */
function getProtocol(ctx: unknown): SSH2Protocol {
  const proto = (ctx as { _protocol?: unknown })._protocol
  if (!proto || typeof proto !== 'object' || !('_packetRW' in proto) || !('_cipher' in proto)) {
    throw new Error('ssh2 internals changed - _protocol._packetRW/_cipher no longer available')
  }
  return proto as SSH2Protocol
}

/**
 * Send a USERAUTH_BANNER packet to a client during the auth phase.
 * This is the SSH-standard way to display a message before auth completes.
 * Visible to OpenSSH CLI, ssh2 clients ('banner' event), and other SSH clients.
 *
 * Note: Uses ssh2 protocol internals since there's no public API for per-connection banners.
 */
function sendAuthBanner(protocol: SSH2Protocol, message: string): void {
  const text = message.endsWith('\r\n') ? message : `${message}\r\n`
  const textLen = Buffer.byteLength(text)
  let p = protocol._packetRW.write.allocStart
  const packet = protocol._packetRW.write.alloc(1 + 4 + textLen + 4)

  packet[p] = 53 // SSH_MSG_USERAUTH_BANNER
  p++
  packet.writeUInt32BE(textLen, p)
  p += 4
  packet.write(text, p, textLen, 'utf8')
  p += textLen
  packet.writeUInt32BE(0, p) // Empty language tag

  protocol._cipher.encrypt(protocol._packetRW.write.finalize(packet))
}

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
const pad = (count: number) => ' '.repeat(count)
// const pad = '                                         '

const BANNER =
  `${green(LOGO)}\r\n\r\n` +
  `Docs-over-SSH lets your agent browse Supabase documentation directly using bash.\r\n\r\n` +
  `Tell your agent to use ${chalk.dim('ssh supabase.sh <command>')} to search the docs:\r\n\r\n` +
  `${bg(pad(36))}\r\n` +
  `${bg(`  ${chalk.dim(`# Setup using claude`)}              `)}\r\n` +
  `${bg(`  $ ssh supabase.sh setup | claude  `)}\r\n` +
  `${bg(pad(36))}\r\n\r\n` +
  `${bg(pad(41))}\r\n` +
  `${bg(`  ${chalk.dim(`# Or append directly to AGENTS.md`)}      `)}\r\n` +
  `${bg(`  $ ssh supabase.sh agents >> AGENTS.md  `)}\r\n` +
  `${bg(pad(41))}\r\n\r\n` +
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
  /** Max concurrent connections from a single IP (in-memory, per instance). */
  maxConnectionsPerIp?: number
  /** Root directory for docs content. */
  docsDir?: string
  /**
   * Sliding-window rate limiter (Redis-backed, cluster-wide). Caps total connection
   * opens per IP per window - prevents rapid connect/disconnect abuse. Complements
   * maxConnectionsPerIp which caps concurrent connections per instance.
   */
  rateLimiter?: RateLimiter
  /** Command result cache. Defaults to enabled. Pass `false` to disable, or a pre-built instance to share. */
  commandCache?: false | CommandCacheOptions | CommandCache
}

/** Creates a testable SSH server. Call listen() to start, close() to stop. */
export function createSSHServer(opts: SSHServerOptions) {
  const {
    hostKey,
    port = 22,
    idleTimeout = 60_000,
    sessionTimeout = 600_000,
    execTimeout = 10_000,
    softLimit = 80,
    hardLimit = 100,
    maxConnectionsPerIp = 10,
    docsDir,
    rateLimiter,
  } = opts

  const activeClients = new Map<ssh2.Connection, { ip: string; channels: Set<ServerChannel> }>()
  const commandCache =
    opts.commandCache instanceof CommandCache
      ? opts.commandCache
      : opts.commandCache !== false
        ? new CommandCache(opts.commandCache === undefined ? undefined : opts.commandCache)
        : null
  let isShuttingDown = false

  /** Execute a command via a fresh Bash sandbox and cache the result. */
  async function execAndCache(cwd: string, command: string, cmdSpan: Span) {
    const { bash, fs } = await createBash(docsDir)
    if (shouldObserveFs(command)) fs.startObservingReads()
    try {
      const result = await bash.exec(command, { cwd, signal: AbortSignal.timeout(execTimeout) })
      commandCache?.set(cwd, command, result)
      return result
    } finally {
      const { files, dirs } = fs.stopObservingReads()
      setReadPaths(cmdSpan, files, dirs)
    }
  }

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
      activeClients.set(client, { ip: info.ip, channels })
      incActiveConnections()

      const sessionCtx = createSessionContext(info)
      const sessionStartTime = Date.now()
      let sessionMode: 'exec' | 'shell' = 'exec'
      let sessionCounted = false
      let endReason = 'user_exit'

      // Start rate limit check early - runs in parallel with SSH handshake
      const rateLimitResult = rateLimiter
        ? rateLimiter.limit(info.ip).catch(() => ({ success: true, reset: 0 }))
        : null

      let activeChannel: ServerChannel | null = null

      const endSession = (reason: string) => {
        console.log(`Client ${reason}, disconnecting`)
        endReason = reason === 'idle timeout' ? 'idle_timeout' : 'max_timeout'
        if (activeChannel) {
          activeChannel.write(
            `\r\n\r\n${green('Session timed out. Reconnect by running: ssh supabase.sh')}\r\n\r\n`,
          )
        }
        setTimeout(() => client.end(), 500)
      }

      const idleTimer = setTimeout(() => endSession('idle timeout'), idleTimeout)
      const sessionTimer = setTimeout(() => endSession('max session reached'), sessionTimeout)
      const resetIdle = () => {
        idleTimer.refresh()
      }

      /** Sends a banner and disconnects. Used by limit checks below. */
      function reject(proto: SSH2Protocol, message: string): void {
        sendAuthBanner(proto, message)
        // Small delay so the banner flushes before the TCP FIN.
        setTimeout(() => client.end(), 50)
      }

      /** Probabilistic capacity check. Returns true if rejected. */
      function rejectIfAtCapacity(proto: SSH2Protocol): boolean {
        if (activeClients.size < softLimit) return false
        const dropProbability =
          activeClients.size >= hardLimit
            ? 1
            : (activeClients.size - softLimit) / (hardLimit - softLimit)
        if (Math.random() >= dropProbability) return false

        console.warn(
          `Rejecting connection: ${activeClients.size} active (soft=${softLimit} hard=${hardLimit} p=${dropProbability.toFixed(2)})`,
        )
        recordConnectionRejected(sessionCtx, activeClients.size, dropProbability)
        incConnectionRejections()
        reject(proto, 'Server is at capacity. Try again in a moment.')
        return true
      }

      /** Per-IP concurrency check. Returns true if rejected. */
      function rejectIfOverIpLimit(proto: SSH2Protocol): boolean {
        let ipCount = 0
        for (const [, entry] of activeClients) {
          if (entry.ip === info.ip) ipCount++
        }
        if (ipCount <= maxConnectionsPerIp) return false

        incConcurrencyRejections()
        recordConcurrencyLimited(sessionCtx, ipCount)
        reject(proto, 'Too many concurrent connections. Disconnect a session and retry.')
        return true
      }

      /** Redis-backed sliding window rate limit. Returns true if rejected. */
      async function rejectIfRateLimited(proto: SSH2Protocol): Promise<boolean> {
        if (!rateLimitResult) return false
        const { success, reset } = await rateLimitResult
        if (success) return false

        incRateLimitRejections()
        const retryIn = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
        recordRateLimited(sessionCtx, retryIn)
        reject(proto, `Too many connections. Retry in ${retryIn}s.`)
        return true
      }

      // All limit checks run during auth - rejected clients never reach a channel.
      // Rejection messages are sent as SSH USERAUTH_BANNER packets (RFC 4252 s5.4),
      // visible to OpenSSH CLI, ssh2 clients, and other standard SSH clients.
      client.on('authentication', async (ctx) => {
        const proto = getProtocol(ctx)
        if (rejectIfAtCapacity(proto)) return
        if (rejectIfOverIpLimit(proto)) return
        if (await rejectIfRateLimited(proto)) return
        ctx.accept()
      })

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
            sessionCounted = true
            incSessions('exec')
            resetIdle()
            const channel = accept()
            channels.add(channel)
            channel.on('close', () => channels.delete(channel))
            const command = execInfo.command
            console.log(`exec: ${command}`)

            const cmdStart = Date.now()
            const cmdSpan = startCommandSpan(sessionCtx, command)
            try {
              const cwd = '/supabase'
              const cached = commandCache?.get(cwd, command)
              if (commandCache) {
                if (cached) incCommandCacheHit()
                else incCommandCacheMiss()
              }
              const cacheHit = !!cached
              const result = cached ?? (await execAndCache(cwd, command, cmdSpan))
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
                cacheHit,
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
            sessionCounted = true
            incSessions('shell')
            const channel = accept()
            activeChannel = channel
            channels.add(channel)
            channel.on('close', () => channels.delete(channel))

            channel.on('data', () => resetIdle())

            let activeSpan: Span | null = null
            const { bash, fs } = await createBash(docsDir)
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
                  if (shouldObserveFs(command)) fs.startObservingReads()
                }
              },
              afterExec: (cmdInfo) => {
                if (activeSpan) {
                  const { files, dirs } = fs.stopObservingReads()
                  setReadPaths(activeSpan, files, dirs)
                }
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
        decActiveConnections()
        if (sessionCounted) {
          const reason = isShuttingDown ? 'server_shutdown' : endReason
          observeSessionDuration((Date.now() - sessionStartTime) / 1000, sessionMode, reason)
        }
      })
      client.on('error', (err) => console.error('Client error:', err.message))
    },
  )

  return {
    server,

    get activeConnectionCount() {
      return activeClients.size
    },

    get cacheStats() {
      return commandCache?.stats ?? null
    },

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
      if (commandCache) {
        const stats = commandCache.stats
        console.log(
          `Command cache: ${stats.entries} entries, ${stats.hits} hits, ${stats.misses} misses, ${(stats.hitRate * 100).toFixed(1)}% hit rate`,
        )
      }
      isShuttingDown = true

      // 1. Stop accepting new connections
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })

      if (activeClients.size > 0) {
        // 2. Notify active shell sessions immediately
        if (message) {
          for (const [, { channels }] of activeClients) {
            for (const channel of channels) {
              channel.write(message)
            }
          }
        }

        // 3. Wait for in-flight commands to finish naturally
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

        // 4. If drain timed out, force-disconnect remaining sessions
        if (timedOut) {
          for (const [, { channels }] of activeClients) {
            for (const channel of channels) {
              channel.exit(255)
            }
          }
          // Allow message to reach remote before tearing down the transport
          await new Promise<void>((resolve) => setTimeout(resolve, 500))
          for (const [c] of activeClients) {
            c.end()
          }
        }
      }

      await serverClosed
    },
  }
}
