import { describe, it, expect, beforeAll } from 'vitest'
import { Bash } from 'just-bash'
import {
  findCmdStart,
  parseCompletionContext,
  shellQuote,
  formatHits,
  createCompletionEngine,
  type CommandCompleteFn,
} from './completion.js'

// ---------------------------------------------------------------------------
// findCmdStart
// ---------------------------------------------------------------------------
describe('findCmdStart', () => {
  it('returns 0 for simple commands', () => {
    expect(findCmdStart('ls -la')).toBe(0)
    expect(findCmdStart('echo hello world')).toBe(0)
  })

  it('finds start after semicolon', () => {
    expect(findCmdStart('ls; cd ')).toBe(3)
    expect(findCmdStart('a; b; c')).toBe(5)
  })

  it('finds start after pipe', () => {
    expect(findCmdStart('cat file | grep pat')).toBe(10)
  })

  it('finds start after &', () => {
    expect(findCmdStart('sleep 1 & echo done')).toBe(9)
  })

  it('finds start after ( for subshell', () => {
    expect(findCmdStart('echo $(custom-cmd arg')).toBe(7)
  })

  it('finds start after backtick', () => {
    expect(findCmdStart('echo `custom-cmd arg')).toBe(6)
  })

  it('handles nested $( correctly', () => {
    expect(findCmdStart('echo $(a $(b ')).toBe(11)
  })

  it('skips separators inside double quotes', () => {
    expect(findCmdStart('echo "a;b" ')).toBe(0)
  })

  it('skips separators inside single quotes', () => {
    expect(findCmdStart("echo 'a|b' ")).toBe(0)
  })

  it('handles && (double ampersand)', () => {
    expect(findCmdStart('ls && echo done')).toBe(5)
  })

  it('handles || (double pipe)', () => {
    expect(findCmdStart('ls || echo fallback')).toBe(5)
  })

  it('returns 0 for empty string', () => {
    expect(findCmdStart('')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseCompletionContext
// ---------------------------------------------------------------------------
describe('parseCompletionContext', () => {
  it('detects command position at start of line', () => {
    const ctx = parseCompletionContext('ls')
    expect(ctx.inCommandPosition).toBe(true)
    expect(ctx.word).toBe('ls')
    expect(ctx.command).toBe('ls')
  })

  it('detects command position with empty input', () => {
    const ctx = parseCompletionContext('')
    expect(ctx.inCommandPosition).toBe(true)
    expect(ctx.word).toBe('')
  })

  it('detects argument position', () => {
    const ctx = parseCompletionContext('echo hel')
    expect(ctx.inCommandPosition).toBe(false)
    expect(ctx.word).toBe('hel')
    expect(ctx.command).toBe('echo')
    expect(ctx.args).toEqual(['hel'])
  })

  it('detects empty word with trailing space', () => {
    const ctx = parseCompletionContext('echo ')
    expect(ctx.inCommandPosition).toBe(false)
    expect(ctx.word).toBe('')
    expect(ctx.command).toBe('echo')
  })

  it('detects command position after semicolon', () => {
    const ctx = parseCompletionContext('ls; cd')
    expect(ctx.inCommandPosition).toBe(true)
    expect(ctx.word).toBe('cd')
    expect(ctx.command).toBe('cd')
  })

  it('detects command position after pipe', () => {
    const ctx = parseCompletionContext('cat file | gre')
    expect(ctx.inCommandPosition).toBe(true)
    expect(ctx.word).toBe('gre')
  })

  it('detects argument position inside subshell', () => {
    const ctx = parseCompletionContext('echo $(custom-cmd arg')
    expect(ctx.inCommandPosition).toBe(false)
    expect(ctx.command).toBe('custom-cmd')
    expect(ctx.word).toBe('arg')
  })

  it('detects command position inside subshell with trailing space', () => {
    const ctx = parseCompletionContext('echo $(')
    expect(ctx.inCommandPosition).toBe(true)
    expect(ctx.word).toBe('')
  })

  it('handles multiple args', () => {
    const ctx = parseCompletionContext('grep -r pattern fi')
    expect(ctx.command).toBe('grep')
    expect(ctx.args).toEqual(['-r', 'pattern', 'fi'])
    expect(ctx.word).toBe('fi')
  })

  it('handles leading whitespace', () => {
    const ctx = parseCompletionContext('  echo hello')
    expect(ctx.command).toBe('echo')
    expect(ctx.word).toBe('hello')
    expect(ctx.inCommandPosition).toBe(false)
  })

  it('detects command position after &&', () => {
    const ctx = parseCompletionContext('ls && ech')
    expect(ctx.inCommandPosition).toBe(true)
    expect(ctx.word).toBe('ech')
  })
})

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------
describe('shellQuote', () => {
  it('returns quoted empty string', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('passes through safe characters', () => {
    expect(shellQuote('hello')).toBe('hello')
    expect(shellQuote('file.txt')).toBe('file.txt')
    expect(shellQuote('path/to/dir')).toBe('path/to/dir')
    expect(shellQuote('a-b_c.d')).toBe('a-b_c.d')
  })

  it('quotes strings with special characters', () => {
    expect(shellQuote('hello world')).toBe("'hello world'")
    expect(shellQuote('a;b')).toBe("'a;b'")
  })

  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

// ---------------------------------------------------------------------------
// formatHits
// ---------------------------------------------------------------------------
describe('formatHits', () => {
  it('returns empty array for no hits', () => {
    expect(formatHits([])).toEqual([])
  })

  it('appends space suffix for single hit', () => {
    expect(formatHits(['echo'])).toEqual(['echo '])
  })

  it('returns multiple hits unchanged', () => {
    expect(formatHits(['echo', 'exit'])).toEqual(['echo', 'exit'])
  })

  it('supports custom suffix for single hit', () => {
    expect(formatHits(['value'], '}')).toEqual(['value}'])
  })
})

// ---------------------------------------------------------------------------
// Engine integration tests (real just-bash instance)
// ---------------------------------------------------------------------------
describe('createCompletionEngine', () => {
  let bash: Bash

  beforeAll(() => {
    bash = new Bash({
      cwd: '/home',
      files: {
        '/home/file.txt': 'hello',
        '/home/readme.md': 'world',
        '/home/docs/guide.md': 'guide',
      },
    })
  })

  describe('syntax-aware completion', () => {
    it('completes $P with variable names', async () => {
      const engine = createCompletionEngine(bash)
      const [hits, word] = await engine.complete('echo $P', '/home')
      expect(word).toBe('$P')
      expect(hits.some((h) => h.startsWith('$P'))).toBe(true)
    })

    it('completes ${P with closing brace', async () => {
      const engine = createCompletionEngine(bash)
      const [hits, word] = await engine.complete('echo ${P', '/home')
      expect(word).toBe('${P')
      expect(hits.every((h) => h.startsWith('${') && h.endsWith('}'))).toBe(true)
    })

    it('completes $( as command position via findCmdStart', async () => {
      // findCmdStart splits at (, so $(ech becomes command position with word "ech"
      const engine = createCompletionEngine(bash)
      const [hits, word] = await engine.complete('echo $(ech', '/home')
      expect(word).toBe('ech')
      expect(hits.some((h) => h === 'echo ' || h === 'echo')).toBe(true)
    })

    it('completes backtick as command position via findCmdStart', async () => {
      // findCmdStart splits at `, so `ech becomes command position with word "ech"
      const engine = createCompletionEngine(bash)
      const [hits, word] = await engine.complete('echo `ech', '/home')
      expect(word).toBe('ech')
      expect(hits.some((h) => h === 'echo ' || h === 'echo')).toBe(true)
    })

    it('completes bare $ with all variables', async () => {
      const engine = createCompletionEngine(bash)
      const [hits, word] = await engine.complete('echo $', '/home')
      expect(word).toBe('$')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.startsWith('$'))).toBe(true)
    })

    it('syntax-aware trumps completeFn', async () => {
      const completeFn: CommandCompleteFn = async () => ['should-not-appear']
      const engine = createCompletionEngine(bash, completeFn)
      const [hits] = await engine.complete('echo $P', '/home')
      expect(hits).not.toContain('should-not-appear')
    })
  })

  describe('command position completion', () => {
    it('completes commands at start of line', async () => {
      const engine = createCompletionEngine(bash)
      const [hits, word] = await engine.complete('ech', '/home')
      expect(word).toBe('ech')
      expect(hits.some((h) => h === 'echo ' || h === 'echo')).toBe(true)
    })

    it('completes commands after semicolon', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('ls; ech', '/home')
      expect(hits.some((h) => h === 'echo ' || h === 'echo')).toBe(true)
    })

    it('completes commands after pipe', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('cat file | gre', '/home')
      expect(hits.some((h) => h === 'grep ' || h === 'grep')).toBe(true)
    })
  })

  describe('completeFn hook', () => {
    it('receives correct command context', async () => {
      let captured: { command: string; args: string[]; word: string } | null = null
      const completeFn: CommandCompleteFn = async (ctx) => {
        captured = { command: ctx.command, args: ctx.args, word: ctx.word }
        return ['result']
      }
      const engine = createCompletionEngine(bash, completeFn)
      await engine.complete('mycmd --flag val', '/home')
      expect(captured).toEqual({
        command: 'mycmd',
        args: ['--flag', 'val'],
        word: 'val',
      })
    })

    it('receives correct context inside subshell', async () => {
      let captured: { command: string; word: string } | null = null
      const completeFn: CommandCompleteFn = async (ctx) => {
        captured = { command: ctx.command, word: ctx.word }
        return ['result']
      }
      const engine = createCompletionEngine(bash, completeFn)
      await engine.complete('echo $(custom-cmd arg', '/home')
      expect(captured!.command).toBe('custom-cmd')
      expect(captured!.word).toBe('arg')
    })

    it('returns completeFn results as completions', async () => {
      const completeFn: CommandCompleteFn = async () => ['--verbose', '--version']
      const engine = createCompletionEngine(bash, completeFn)
      const [hits, word] = await engine.complete('mycmd --v', '/home')
      expect(hits).toEqual(['--verbose', '--version'])
      expect(word).toBe('--v')
    })

    it('falls through to file completion when returning empty', async () => {
      const completeFn: CommandCompleteFn = async () => []
      const engine = createCompletionEngine(bash, completeFn)
      const [hits] = await engine.complete('cat read', '/home')
      expect(hits.some((h) => h.startsWith('readme'))).toBe(true)
    })
  })

  describe('file completion', () => {
    it('completes files in cwd', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('cat fi', '/home')
      expect(hits.some((h) => h.startsWith('file.txt'))).toBe(true)
    })

    it('appends / to directories', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('cd doc', '/home')
      expect(hits.some((h) => h === 'docs/')).toBe(true)
    })

    it('completes with directory prefix', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('cat docs/gu', '/home')
      expect(hits.some((h) => h.startsWith('docs/guide'))).toBe(true)
    })

    it('returns empty for nonexistent directory', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('cat nope/', '/home')
      expect(hits).toEqual([])
    })

    it('falls through to files without completeFn', async () => {
      const engine = createCompletionEngine(bash)
      const [hits] = await engine.complete('cat fi', '/home')
      expect(hits.some((h) => h.startsWith('file.txt'))).toBe(true)
    })
  })
})
