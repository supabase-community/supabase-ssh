import { describe, expect, it, vi } from 'vitest'
import { executeBashCommand } from './bash-tool.js'

// ---------------------------------------------------------------------------
// ssh command routing
// ---------------------------------------------------------------------------
describe('ssh supabase.sh routing', () => {
  it('routes ssh supabase.sh <cmd> to EXEC_API_URL and returns stdout', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stdout: 'hello from api\n', stderr: '', exitCode: 0 }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeBashCommand('ssh supabase.sh echo hello')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/exec')
    expect(JSON.parse(opts.body as string)).toEqual({ command: 'echo hello' })
    expect(result.stdout).toContain('hello from api')
    expect(result.exitCode).toBe(0)

    vi.unstubAllGlobals()
  })

  it('returns stderr from API when command fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stdout: '', stderr: 'not found\n', exitCode: 1 }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeBashCommand('ssh supabase.sh ls /nonexistent')

    expect(result.stderr).toContain('not found')
    expect(result.exitCode).toBe(1)

    vi.unstubAllGlobals()
  })

  it('returns error on non-ok HTTP response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal server error' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeBashCommand('ssh supabase.sh broken')

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBeTruthy()

    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// ssh non-supabase.sh targets
// ---------------------------------------------------------------------------
describe('ssh non-supabase.sh target', () => {
  it('returns error for unknown ssh target', async () => {
    const result = await executeBashCommand('ssh example.com echo hi')

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/supabase\.sh/)
  })
})

// ---------------------------------------------------------------------------
// ssh missing remote command
// ---------------------------------------------------------------------------
describe('ssh missing remote command', () => {
  it('returns usage error when no remote command is given', async () => {
    const result = await executeBashCommand('ssh supabase.sh')

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// regular bash commands
// ---------------------------------------------------------------------------
describe('regular bash commands', () => {
  it('executes a basic echo command', async () => {
    const result = await executeBashCommand('echo hello')

    expect(result.stdout).toContain('hello')
    expect(result.exitCode).toBe(0)
  })

  it('returns non-zero exit code for failed commands', async () => {
    const result = await executeBashCommand('exit 1')

    expect(result.exitCode).toBe(1)
  })
})
