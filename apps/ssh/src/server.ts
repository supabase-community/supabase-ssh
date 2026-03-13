import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Bash, defineCommand, MountableFs, OverlayFs } from 'just-bash'
import ssh2 from 'ssh2'

// ssh2 is commonjs
const { Server } = ssh2

const DOCS_DIR = resolve(process.env.DOCS_DIR ?? '../docs/public/docs')
const PORT = parseInt(process.env.PORT ?? '22', 10)

// Aliases as custom commands so just-bash handles piping/redirection correctly.
// e.g. `ll | grep foo` works because just-bash resolves `ll` before building the pipe.
const aliasCommands = [
  defineCommand('ll', (args, ctx) => ctx.exec!(`ls -alF ${args.join(' ')}`, { cwd: ctx.cwd })),
  defineCommand('la', (args, ctx) => ctx.exec!(`ls -a ${args.join(' ')}`, { cwd: ctx.cwd })),
  defineCommand('l', (args, ctx) => ctx.exec!(`ls -CF ${args.join(' ')}`, { cwd: ctx.cwd })),
]

const BANNER =
  '\r\n\x1b[38;2;62;207;142m' +
  '  ____                    _                    \r\n' +
  ' / ___| _   _ _ __   __ _| |__   __ _ ___  ___ \r\n' +
  " \\___ \\| | | | '_ \\ /  ` | '_ \\ / _` / __|/ _ \\\r\n" +
  '  ___) | |_| | |_) | (_| | |_) | (_| \\__ \\  __/\r\n' +
  ' |____/ \\__,_| .__/ \\__,_|_.__/ \\__,_|___/\\___|\r\n' +
  '             |_|\x1b[0m\r\n' +
  '\r\n' +
  ' Tell your agent to run \x1b[2mssh supabase.sh <command>\x1b[0m to search the docs.\r\n' +
  ' Or explore interactively with grep, find, cat, and tree.\r\n' +
  '\r\n' +
  '$ '

function createVfs() {
  return new MountableFs({
    mounts: [
      {
        mountPoint: '/supabase/docs',
        filesystem: new OverlayFs({ root: DOCS_DIR, readOnly: true }),
      },
    ],
  })
}

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

function makeBash() {
  return new Bash({
    fs: createVfs(),
    cwd: '/supabase/docs/guides',
    customCommands: aliasCommands,
  })
}

async function main() {
  const hostKey = await loadHostKey()

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    console.log('Client connected')

    // Accept all auth unconditionally - shell is sandboxed to just-bash
    client.on('authentication', (ctx) => ctx.accept())

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        // No PTY support yet - just accept and ignore requests
        session.on('pty', (accept) => accept())

        session.on('exec', async (accept, _reject, info) => {
          const channel = accept()
          const command = info.command
          console.log(`exec: ${command}`)

          try {
            const bash = makeBash()
            const result = await bash.exec(command)
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
          const bash = makeBash()

          channel.write(BANNER)

          let buf = ''

          // Poor man's interactive shell
          channel.on('data', async (data: Buffer) => {
            const chunk = data.toString()
            for (const ch of chunk) {
              if (ch === '\r' || ch === '\n') {
                channel.write('\r\n')
                const command = buf.trim()
                buf = ''
                if (command === 'exit') {
                  channel.end()
                  return
                }
                if (command) {
                  try {
                    const result = await bash.exec(command)
                    if (result.stdout) channel.write(result.stdout.replace(/\n/g, '\r\n'))
                    if (result.stderr) channel.write(result.stderr.replace(/\n/g, '\r\n'))
                  } catch (err) {
                    channel.write(`Error: ${err instanceof Error ? err.message : String(err)}\r\n`)
                  }
                }
                channel.write('$ ')
              } else if (ch === '\x7f' || ch === '\b') {
                // backspace
                if (buf.length > 0) {
                  buf = buf.slice(0, -1)
                  channel.write('\b \b')
                }
              } else {
                buf += ch
                channel.write(ch)
              }
            }
          })
        })
      })
    })

    client.on('end', () => console.log('Client disconnected'))
    client.on('error', (err) => console.error('Client error:', err.message))
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Docs SSH server listening on port ${PORT}`)
    console.log(`Connect: ssh localhost`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

process.on('SIGTERM', () => {
  console.log('SIGTERM')
  process.exit(0)
})
process.on('SIGINT', () => {
  console.log('SIGINT')
  process.exit(0)
})
