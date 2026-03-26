/**
 * Capture a real agent session against the SSH server.
 *
 * Runs Claude Code via the Agent SDK with a realistic developer prompt.
 * The SSH server's OTel exporter sends spans to the local collector,
 * which writes them to load-test/traces/spans.json.
 *
 * Usage:
 *   pnpm load-test:capture [--prompt <custom-prompt>] [--docker]
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY in environment
 *   - Without --docker: SSH server running locally with OTEL_EXPORTER_OTLP_ENDPOINT
 *   - With --docker: just Docker (server + OTel collector auto-started)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { query } from '@anthropic-ai/claude-agent-sdk'

import { presets, type RunningServer, resetOtelCollector, startServer } from '../docker.js'
import { connect, exec } from '../ssh-client.js'
import { parseProfile } from './parse-profile.js'

// const require = createRequire(import.meta.url)
// const SDK_CLI_PATH = join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'cli.js')

const DEFAULT_PROMPT = `I'm building a todos app with Supabase. Starting with the backend first, can you help me build the tables, APIs, etc?`

const { values } = parseArgs({
  options: {
    prompt: { type: 'string' },
    host: { type: 'string', default: 'localhost' },
    port: { type: 'string', default: '2222' },
    docker: { type: 'boolean', default: false },
  },
})

const prompt = values.prompt ?? DEFAULT_PROMPT
const useDocker = values.docker ?? false

// Create a temp working directory so Claude Code has somewhere to write files
const workDir = mkdtempSync(join(tmpdir(), 'ssh-capture-'))

/** Write an ssh wrapper script that forces our config file */
function writeSshWrapper(host: string, port: number) {
  const sshDir = join(workDir, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  const configPath = join(sshDir, 'config')
  writeFileSync(
    configPath,
    `Host supabase.sh
  HostName ${host}
  Port ${port}
  User user
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
`,
  )

  const binDir = join(workDir, '.bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${configPath} "$@"\n`, {
    mode: 0o755,
  })
}

// Seed a minimal project so Claude has context
writeFileSync(
  join(workDir, 'package.json'),
  JSON.stringify(
    {
      name: 'my-app',
      private: true,
      dependencies: {
        next: '^14.0.0',
        '@supabase/supabase-js': '^2.39.0',
        '@supabase/ssr': '^0.1.0',
      },
    },
    null,
    2,
  ),
)

writeFileSync(
  join(workDir, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2017',
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        strict: true,
        paths: { '@/*': ['./src/*'] },
      },
    },
    null,
    2,
  ),
)

/** Pull text out of a tool_result content field (string or content block array) */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (b: unknown) =>
          typeof b === 'object' &&
          b !== null &&
          'type' in b &&
          (b as { type: string }).type === 'text',
      )
      .map((b: unknown) => (b as { text: string }).text)
    return texts.length > 0 ? texts.join('') : null
  }
  return null
}

/** Format tool arguments for log output */
function formatToolArgs(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') {
    return input.command.length > 200 ? `${input.command.slice(0, 200)}...` : input.command
  }
  if (name === 'Read' && typeof input.file_path === 'string') return input.file_path
  if (name === 'Write' && typeof input.file_path === 'string') return input.file_path
  if (name === 'Edit' && typeof input.file_path === 'string') return input.file_path
  if (name === 'Glob' && typeof input.pattern === 'string') return input.pattern
  if (name === 'Grep' && typeof input.pattern === 'string') return input.pattern
  const json = JSON.stringify(input)
  return json.length > 200 ? `${json.slice(0, 200)}...` : json
}

let server: RunningServer | null = null

async function main() {
  let host = values.host ?? 'localhost'
  let port = parseInt(values.port ?? '2222', 10)

  if (useDocker) {
    console.log('Starting OTel collector + SSH server via Docker...')
    // Reset OTel collector so we only capture this session's spans
    await resetOtelCollector()

    server = await startServer(presets.capture())
    host = '127.0.0.1'
    port = server.sshPort
  }

  writeSshWrapper(host, port)

  // Fetch the real agent instructions from the SSH server
  console.log('Fetching agent instructions from SSH server...')
  const { client, rejected } = await connect({ host, port })
  if (rejected) throw new Error('SSH server rejected connection during setup')
  const { stdout: agentsOutput } = await exec(client, 'agents')
  client.end()

  // Write CLAUDE.md so the agent discovers SSH docs the same way a real developer would
  writeFileSync(join(workDir, 'CLAUDE.md'), `${agentsOutput.trim()}\n`)
  console.log(`Wrote CLAUDE.md (${agentsOutput.trim().split('\n').length} lines)`)

  console.log(`\nCapture session`)
  console.log(`  Working directory: ${workDir}`)
  console.log(`  SSH target: ${host}:${port}`)
  console.log(`  Docker: ${useDocker}`)
  console.log(`  Prompt: ${prompt.slice(0, 100)}...`)
  console.log('')

  const stream = query({
    prompt,
    options: {
      cwd: workDir,
      // pathToClaudeCodeExecutable: SDK_CLI_PATH,
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: [
        'Bash(ssh supabase.sh:*)',
        'Bash(head:*)',
        'Bash(tail:*)',
        'Bash(grep:*)',
        'Bash(cat:*)',
        'Bash(wc:*)',
        'Bash(sort:*)',
        'Bash(cut:*)',
        'Bash(sed:*)',
        'Bash(find:*)',
        'Bash(ls:*)',
        'Bash(mkdir:*)',
        'Bash(echo:*)',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
      ],
      permissionMode: 'dontAsk',
      settingSources: ['project'],
      maxTurns: 100,
      maxBudgetUsd: 5,
      effort: 'medium',
      env: {
        HOME: workDir,
        PATH: [
          join(workDir, '.bin'), // ssh wrapper
          dirname(process.execPath), // node binary
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
        ].join(':'),
        SHELL: '/bin/bash',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      },
      persistSession: false,
    },
  })

  for await (const message of stream) {
    const isSubagent = 'parent_tool_use_id' in message && message.parent_tool_use_id
    const prefix = isSubagent ? '  [sub] ' : ''

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          process.stdout.write(prefix + block.text)
        } else if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown>
          const args = formatToolArgs(block.name, input)
          console.log(`\n${prefix}[tool: ${block.name}] ${args}`)
        }
      }
    } else if (message.type === 'user') {
      // Tool results come back as user messages with tool_result content blocks
      const content = message.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            const result = block as { is_error?: boolean; content?: unknown }
            const text = extractToolResultText(result.content)
            const preview = text
              ? `${text.slice(0, 200).replace(/\n/g, '\\n')}... (${text.length} chars)`
              : ''
            if (result.is_error) {
              console.log(`${prefix}  -> ERROR ${preview}`)
            } else if (text) {
              console.log(`${prefix}  -> OK ${preview}`)
            }
          }
        }
      }
    } else if (message.type === 'tool_use_summary') {
      // Human-readable summary of tool results (e.g. "Read 50 lines from file.ts")
      console.log(`${prefix}  -> ${message.summary}`)
    } else if (message.type === 'system' && 'subtype' in message) {
      const sub = (message as { subtype: string }).subtype
      if (sub === 'task_started') {
        const task = message as { description?: string }
        console.log(`\n[subagent started] ${task.description ?? ''}`)
      } else if (sub === 'task_progress') {
        const msg = message as { summary?: string }
        if (msg.summary) console.log(`  [subagent] ${msg.summary}`)
      } else if (sub === 'task_notification') {
        const notif = message as { status?: string }
        console.log(`[subagent ${notif.status ?? 'done'}]`)
      }
    } else if (message.type === 'result') {
      console.log(`\n\nSession complete: ${message.subtype}`)
      if (message.usage) {
        console.log(`Tokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`)
        if (message.usage.total_cost_usd) {
          console.log(`Cost: $${message.usage.total_cost_usd.toFixed(4)}`)
        }
      }
    }
  }
}

main()
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
  .finally(async () => {
    if (server) {
      console.log('Stopping Docker server...')
      await server.stop()
    }
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      console.warn(`Warning: could not clean up ${workDir}`)
    }
    // Parse spans into session profile
    const dir = import.meta.dirname ?? __dirname
    const spansPath = join(dir, '..', 'traces', 'spans.json')
    const profilePath = join(dir, '..', 'profiles', 'captured-agent.json')
    parseProfile(spansPath, profilePath)
  })
