import { PassThrough } from 'node:stream'
import { describe, it, expect, vi } from 'vitest'
import { Bash } from 'just-bash'
import { ShellSession, type ShellSessionOptions } from './shell-session.js'

const PROMPT_RE = /\$ $/

function createHarness(overrides?: Partial<ShellSessionOptions>) {
  const input = new PassThrough()
  const output = new PassThrough({ encoding: 'utf-8' })
  const bash = new Bash({
    cwd: '/home',
    files: {
      '/home/file.txt': 'hello',
      '/home/sub/nested.txt': 'nested',
    },
  })

  const session = new ShellSession({
    bash,
    input,
    output,
    terminal: false,
    prompt: (cwd) => `${cwd} $ `,
    ...overrides,
  })

  return { input, output, session, bash }
}

/** Collect output until the prompt appears (or timeout). */
function waitForPrompt(output: PassThrough, timeout = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for prompt. Got: ${JSON.stringify(buf)}`)),
      timeout
    )
    const onData = (chunk: string) => {
      buf += chunk
      if (PROMPT_RE.test(buf)) {
        clearTimeout(timer)
        output.removeListener('data', onData)
        resolve(buf)
      }
    }
    output.on('data', onData)
  })
}

function sendLine(input: PassThrough, cmd: string) {
  input.write(cmd + '\n')
}

// ---------------------------------------------------------------------------
// Shell session unit tests
// ---------------------------------------------------------------------------
describe('ShellSession', () => {
  it('writes initial prompt on construction', async () => {
    const { output, session } = createHarness()
    const buf = await waitForPrompt(output)
    expect(buf).toContain('/home $ ')
    session.close()
  })

  it('writes banner before first prompt', async () => {
    const { output, session } = createHarness({ banner: 'Welcome!\r\n' })
    const buf = await waitForPrompt(output)
    expect(buf).toMatch(/^Welcome!\r\n/)
    expect(buf).toContain('/home $ ')
    session.close()
  })

  it('executes command and writes output', async () => {
    const { input, output, session } = createHarness()
    await waitForPrompt(output)
    sendLine(input, 'echo hello')
    const buf = await waitForPrompt(output)
    expect(buf).toContain('hello')
    session.close()
  })

  it('translates LF to CRLF in output', async () => {
    const { input, output, session } = createHarness()
    await waitForPrompt(output)
    sendLine(input, 'echo -e "a\\nb"')
    const buf = await waitForPrompt(output)
    expect(buf).toContain('a\r\nb\r\n')
    session.close()
  })

  it('updates prompt after cd', async () => {
    const { input, output, session } = createHarness()
    await waitForPrompt(output)
    sendLine(input, 'cd sub')
    const buf = await waitForPrompt(output)
    expect(buf).toContain('/home/sub $ ')
    session.close()
  })

  it('skips execution when onLine returns false', async () => {
    // onLine returns false only for 'skip-me', allowing 'echo after' through
    const onLine = vi.fn((cmd: string) => (cmd === 'skip-me' ? false : undefined))
    const { input, output, session } = createHarness({ onLine })
    await waitForPrompt(output)

    // When onLine returns false, handleLine returns early (no prompt, no exec).
    // This matches real usage where the server closes the channel on 'exit'.
    // Send both lines - the second will produce a prompt we can wait for.
    sendLine(input, 'skip-me')
    sendLine(input, 'echo after')
    const buf = await waitForPrompt(output)

    // 'echo after' ran, so we see its output. 'skip-me' was never executed.
    expect(buf).toContain('after')
    expect(onLine).toHaveBeenCalledWith('skip-me')
    expect(onLine).toHaveBeenCalledWith('echo after')
    session.close()
  })

  it('calls onExit when session closes', async () => {
    const onExit = vi.fn()
    const { output, session } = createHarness({ onExit })
    await waitForPrompt(output)
    session.close()
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('does not exec empty lines', async () => {
    const { input, output, session } = createHarness()
    await waitForPrompt(output)
    sendLine(input, '')

    // Should just re-prompt with no output in between
    const buf = await waitForPrompt(output)
    expect(buf).toBe('/home $ ')
    session.close()
  })

  it('persists cwd across multiple commands', async () => {
    const { input, output, session } = createHarness()
    await waitForPrompt(output)

    sendLine(input, 'cd sub')
    await waitForPrompt(output)

    sendLine(input, 'pwd')
    const buf = await waitForPrompt(output)
    expect(buf).toContain('/home/sub')
    expect(buf).toContain('/home/sub $ ')
    session.close()
  })
})
