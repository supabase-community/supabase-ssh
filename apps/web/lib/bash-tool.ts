import type { BashExecResult } from 'just-bash'
import { Bash, defineCommand, InMemoryFs } from 'just-bash'

const EXEC_API_URL = process.env.EXEC_API_URL ?? 'https://supabase.sh/api/exec'

const TIMEOUT_MS = 15_000

/** Custom ssh command that intercepts `ssh supabase.sh <cmd>` and routes it to the exec API. */
const sshCommand = defineCommand('ssh', async (args) => {
  const [target, ...rest] = args

  if (target !== 'supabase.sh') {
    return {
      stdout: '',
      stderr: `ssh: only supabase.sh is supported as a remote target\n`,
      exitCode: 255,
    }
  }

  if (rest.length === 0) {
    return {
      stdout: '',
      stderr: `usage: ssh supabase.sh <command>\n`,
      exitCode: 1,
    }
  }

  const command = rest.join(' ')

  let res: Response
  try {
    res = await fetch(EXEC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return {
      stdout: '',
      stderr: `ssh: connection failed: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 255,
    }
  }

  const body = (await res.json()) as {
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
  }

  if (!res.ok) {
    return {
      stdout: '',
      stderr: `ssh: remote error: ${body.error ?? `HTTP ${res.status}`}\n`,
      exitCode: 1,
    }
  }

  return {
    stdout: body.stdout ?? '',
    stderr: body.stderr ?? '',
    exitCode: body.exitCode ?? 0,
  }
})

/**
 * Execute a bash command in an isolated in-memory shell.
 * The `ssh supabase.sh <cmd>` command routes to EXEC_API_URL.
 */
export async function executeBashCommand(command: string): Promise<BashExecResult> {
  const fs = new InMemoryFs()
  const bash = new Bash({
    fs,
    customCommands: [sshCommand],
  })

  return bash.exec(command, { signal: AbortSignal.timeout(TIMEOUT_MS) })
}
