import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { Chalk } from 'chalk'
import ssh2, { type ServerChannel } from 'ssh2'

import { createBash } from './bash.js'
import { ShellSession } from './shell-session.js'

// ssh2 is commonjs
const { Server } = ssh2

// Force truecolor - output goes to SSH channels, not stdout
const chalk = new Chalk({ level: 3 })
const green = chalk.rgb(62, 207, 142)

const PORT = parseInt(process.env.PORT ?? '22', 10)
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS ?? '30000', 10)
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS ?? '100', 10)
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT ?? '10000', 10)

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

const SSH_HOST_KEY_PATH = resolve(process.env.SSH_HOST_KEY_PATH ?? './ssh_host_key')

async function loadHostKey(): Promise<Buffer> {
  // Prefer SSH_HOST_KEY env var
  if (process.env.SSH_HOST_KEY) {
    const pem = process.env.SSH_HOST_KEY
    const fingerprint = createHash('sha256').update(pem).digest('base64')
    console.log(`Loaded host key from SSH_HOST_KEY env var (SHA256:${fingerprint})`)
    return Buffer.from(pem)
  }

  const pem = await readFile(SSH_HOST_KEY_PATH)
  const fingerprint = createHash('sha256').update(pem).digest('base64')
  console.log(`Loaded host key from ${SSH_HOST_KEY_PATH} (SHA256:${fingerprint})`)
  return pem
}

/** All channels with an interactive shell - used for graceful shutdown messages. */
const activeChannels = new Set<ServerChannel>()

let totalConnections = 0
let activeConnections = 0

const RSS_LIMIT = 512 * 1024 * 1024 // match fly.toml [[vm]] memory
const MEMORY_WARN_THRESHOLD = 0.85

function logStats(event: string) {
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

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

async function main() {
  const hostKey = await loadHostKey()

  logStats('startup')

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
      logStats('connect')

      if (activeConnections > MAX_CONNECTIONS) {
        console.log(`Rejecting connection: ${activeConnections}/${MAX_CONNECTIONS}`)
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
      }, IDLE_TIMEOUT_MS)
      const resetIdle = () => {
        idleTimer.refresh()
      }

      // Accept all auth unconditionally - shell is sandboxed to just-bash
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
              const bash = createBash()
              const result = await bash.exec(command, { signal: AbortSignal.timeout(EXEC_TIMEOUT) })
              if (result.stdout) channel.write(result.stdout)
              if (result.stderr) channel.stderr.write(result.stderr)
              channel.exit(result.exitCode)
            } catch (err) {
              channel.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
              channel.exit(1)
            }

            channel.end()
          })

          session.on('shell', async (accept) => {
            const channel = accept()
            activeChannel = channel
            activeChannels.add(channel)
            channel.on('close', () => activeChannels.delete(channel))

            // Reset idle on any keystroke
            channel.on('data', () => resetIdle())

            const bash = createBash()
            const shell = new ShellSession({
              bash,
              input: channel,
              output: channel,
              terminal: hasPty,
              execTimeout: EXEC_TIMEOUT,
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
        logStats('disconnect')
      })
      client.on('error', (err) => console.error('Client error:', err.message))
    }
  )

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SSH server listening on port ${PORT}`)
    console.log(`Connect: ssh localhost`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

function gracefulShutdown(signal: string) {
  console.log(`${signal} received, notifying ${activeChannels.size} active session(s)`)
  for (const channel of activeChannels) {
    channel.write(
      `\r\n\r\n${green('Quick update in progress - reconnect in a few seconds!')}\r\n\r\n`
    )
    channel.end()
  }
  // Give channels a moment to flush before exiting
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
