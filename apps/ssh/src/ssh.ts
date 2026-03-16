import { posix } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Chalk } from 'chalk'
import ssh2, { type ServerChannel } from 'ssh2'

import { createBash } from './bash.js'
import { ShellSession } from './shell-session.js'

const { Server } = ssh2

// Force truecolor - output goes to SSH channels, not stdout
const chalk = new Chalk({ level: 3 })
const green = chalk.rgb(62, 207, 142)

const LOGO =
  '  ____                    _                    \r\n' +
  ' / ___| _   _ _ __   __ _| |__   __ _ ___  ___ \r\n' +
  " \\___ \\| | | | '_ \\ /  ` | '_ \\ / _` / __|/ _ \\\r\n" +
  '  ___) | |_| | |_) | (_| | |_) | (_| \\__ \\  __/\r\n' +
  ' |____/ \\__,_| .__/ \\__,_|_.__/ \\__,_|___/\\___|\r\n' +
  '             |_|'

const BANNER =
  `\r\n${green(LOGO)}\r\n` +
  `\r\n Tell your agent to run ${chalk.dim('ssh supabase.sh <command>')} to search the docs.\r\n` +
  ' Or explore them yourself with grep, find, cat, and tree.\r\n\r\n'

export interface SSHServerOptions {
  hostKey: Buffer
  port?: number
  idleTimeoutMs?: number
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
    idleTimeoutMs = 30_000,
    maxConnections = 100,
    execTimeout = 10_000,
    docsDir,
  } = opts

  const activeChannels = new Set<ServerChannel>()
  let totalConnections = 0
  let activeConnections = 0

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
    (client) => {
      totalConnections++
      activeConnections++
      logStats('connect', activeConnections, totalConnections)

      if (activeConnections > maxConnections) {
        console.log(`Rejecting connection: ${activeConnections}/${maxConnections}`)
        activeConnections--
        client.end()
        return
      }

      let activeChannel: ServerChannel | null = null
      const idleTimer = setTimeout(() => {
        console.log('Client idle timeout, disconnecting')
        if (activeChannel) {
          activeChannel.write(
            `\r\n\r\n${green('Session timed out. Thanks for stopping by!')}\r\n\r\n`
          )
        }
        setTimeout(() => client.end(), 500)
      }, idleTimeoutMs)
      const resetIdle = () => {
        idleTimer.refresh()
      }

      client.on('authentication', (ctx) => ctx.accept())

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()

          let hasPty = false
          session.on('pty', (accept) => {
            hasPty = true
            accept()
          })

          session.on('exec', async (accept, _reject, info) => {
            resetIdle()
            const channel = accept()
            const command = info.command
            console.log(`exec: ${command}`)

            try {
              const bash = createBash(docsDir)
              const result = await bash.exec(command, { signal: AbortSignal.timeout(execTimeout) })
              if (result.stdout) channel.write(result.stdout)
              if (result.stderr) channel.stderr.write(result.stderr)
              channel.exit(result.exitCode)
            } catch (err) {
              channel.stderr.write(
                `Error: ${err instanceof Error ? err.message : String(err)}\n`
              )
              channel.exit(1)
            }

            channel.end()
          })

          session.on('shell', async (accept) => {
            const channel = accept()
            activeChannel = channel
            activeChannels.add(channel)
            channel.on('close', () => activeChannels.delete(channel))

            channel.on('data', () => resetIdle())

            const bash = createBash(docsDir)
            const shell = new ShellSession({
              bash,
              input: channel,
              output: channel,
              terminal: hasPty,
              execTimeout,
              banner: BANNER,
              prompt: (cwd) => `${green(posix.basename(cwd))} $ `,
              onLine: (command) => {
                if (command === 'exit') {
                  channel.write(`\r\n${green('Thanks for stopping by!')}\r\n\r\n`)
                  shell.close()
                  channel.end()
                  return false
                }
              },
              onExit: () => channel.end(),
            })
          })
        })
      })

      client.on('end', () => {
        clearTimeout(idleTimer)
        activeConnections--
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
