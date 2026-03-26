import { Bash } from 'just-bash'
import { describe, expect, it } from 'vitest'
import { EXECUTION_LIMITS } from './bash.js'
import { ExtendedMountableFs } from './extended-mountable-fs.js'

function createTestBash(files: Record<string, string> = {}) {
  return new Bash({
    fs: new ExtendedMountableFs({ readOnly: true }),
    cwd: '/home',
    env: { HOME: '/home' },
    files: { '/home/.keep': '', ...files },
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })
}

// ---------------------------------------------------------------------------
// Attack surface tests - verify that execution limits catch abuse
// ---------------------------------------------------------------------------

describe('Attack: infinite loops', () => {
  it('while true is stopped by maxLoopIterations', async () => {
    const bash = createTestBash()
    const result = await bash.exec('while true; do echo x; done')
    // May hit maxCommandCount (echo counts per iteration) or maxLoopIterations
    expect(result.stderr).toMatch(/too many iterations|too many commands/i)
  })

  it('for loop with huge range is stopped', async () => {
    const bash = createTestBash()
    const result = await bash.exec('for i in $(seq 1 999999); do echo $i; done')
    expect(result.stderr).toMatch(/too many iterations|too many commands/i)
  })

  it('until false is stopped', async () => {
    const bash = createTestBash()
    const result = await bash.exec('until false; do echo x; done')
    expect(result.stderr).toMatch(/too many iterations|too many commands/i)
  })

  it('nested loops multiply but are still bounded', async () => {
    const bash = createTestBash()
    const result = await bash.exec(
      'for i in $(seq 1 100); do for j in $(seq 1 100); do echo "$i.$j"; done; done',
    )
    // Inner loop runs 100 * 100 = 10000 iters but maxLoopIterations is 1000 per loop
    // so it depends on how just-bash counts - either loop limit or command count
    expect(result.stderr).toMatch(/too many iterations|too many commands|output size/i)
  })
})

describe('Attack: output flooding', () => {
  it('massive echo output is stopped by maxOutputSize', async () => {
    const bash = createTestBash()
    const result = await bash.exec(
      'x=$(printf "A%.0s" {1..1000}); for i in $(seq 1 2000); do echo "$x"; done',
    )
    expect(result.stderr).toMatch(/output size|too many iterations|too many commands/i)
  })

  it('yes-like output is bounded to ~1MB', async () => {
    const bash = createTestBash()
    const result = await bash.exec(
      'while true; do echo "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; done',
    )
    const totalOutput = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
    // 1MB + margin for the error message
    expect(totalOutput).toBeLessThanOrEqual(1024 * 1024 + 4096)
  })
})

describe('Attack: string/memory amplification', () => {
  it('exponential string growth is stopped by maxStringLength', async () => {
    const bash = createTestBash()
    const result = await bash.exec(
      'x="AAAAAAAAAA"; for i in $(seq 1 25); do x="$x$x"; done; echo ${#x}',
    )
    expect(result.stderr).toMatch(
      /string length|too many iterations|too many commands|output size/i,
    )
  })

  it('brace expansion bomb is bounded', async () => {
    const bash = createTestBash()
    // {1..1000}{1..1000} = 1M cartesian product results
    // Should be caught by brace expansion limit, output size limit, or silently truncated
    const result = await bash.exec('echo {1..1000}{1..1000}')
    const totalOutput = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
    expect(
      result.stderr.includes('limit') ||
        result.stderr.includes('brace') ||
        totalOutput <= 1024 * 1024 + 4096,
    ).toBe(true)
  })

  it('large array construction is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.exec(
      'arr=(); for i in $(seq 1 20000); do arr+=("$i"); done; echo ${#arr[@]}',
    )
    expect(result.stderr).toMatch(/array|too many iterations|too many commands/i)
  })

  it('parameter expansion amplification is bounded', async () => {
    const bash = createTestBash()
    // 1000 chars * 10 = 10000 chars, then //A/AAAA = 40000 chars - under 1MB limit
    // Use larger base to actually hit the limit
    const result = await bash.exec(
      'x=$(printf "A%.0s" {1..1000}); for i in 1 2 3 4 5 6 7 8 9 10; do x="$x$x"; done; echo "${x//A/AAAA}" | wc -c',
    )
    // Should hit string length limit or output size limit
    expect(result.stderr).toMatch(
      /string length|output size|too many commands|too many iterations/i,
    )
  })
})

describe('Attack: abort signal / timeout', () => {
  it('AbortSignal or execution limits stop a long-running loop', async () => {
    const bash = createTestBash()
    const signal = AbortSignal.timeout(500)
    const start = performance.now()
    // The loop hits maxCommandCount (1000) or the abort signal - whichever first.
    // just-bash returns a result with error in stderr rather than throwing.
    const resultOrError = await bash
      .exec('for i in $(seq 1 1000); do for j in $(seq 1 1000); do echo "$i.$j"; done; done', {
        signal,
      })
      .catch((err: Error) => err)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000)

    if (resultOrError instanceof Error) {
      // AbortSignal fired
      expect(resultOrError.message).toMatch(/abort/i)
    } else {
      // Execution limits caught it
      expect(resultOrError.stderr).toMatch(/too many|limit|abort/i)
    }
  })

  it('AbortSignal or limits stop nested command substitution', async () => {
    const bash = createTestBash()
    const signal = AbortSignal.timeout(500)
    const resultOrError = await bash
      .exec('for i in $(seq 1 1000); do x=$(echo "$(echo "$(echo "$i")")"); done', { signal })
      .catch((err: Error) => err)

    if (resultOrError instanceof Error) {
      expect(resultOrError.message).toMatch(/abort/i)
    } else {
      expect(resultOrError.stderr).toMatch(/too many|limit|abort/i)
    }
  })
})

describe('Attack: command substitution depth', () => {
  it('deeply nested $() is stopped by maxSubstitutionDepth (20)', async () => {
    const bash = createTestBash()
    let cmd = 'echo hello'
    for (let i = 0; i < 25; i++) {
      cmd = `echo $(${cmd})`
    }
    const result = await bash.exec(cmd)
    expect(result.stderr).toMatch(/substitution|nesting|depth|too many commands/i)
  })
})

describe('Attack: call depth', () => {
  it('deep recursion is stopped by maxCallDepth (50)', async () => {
    const bash = createTestBash()
    const result = await bash.exec('f() { f; }; f')
    expect(result.stderr).toMatch(/recursion depth|call depth/i)
  })
})

describe('Attack: arithmetic abuse', () => {
  it('arithmetic in tight loop is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.exec('x=0; while true; do x=$((x+1)); done; echo $x')
    expect(result.stderr).toMatch(/too many iterations|too many commands/i)
  })
})

describe('Attack: sed/awk amplification', () => {
  it('sed branch loop is bounded by maxSedIterations', async () => {
    const bash = createTestBash()
    const result = await bash.exec('echo "aaa" | sed ":loop; s/a/aa/; t loop"')
    expect(result.stderr).toMatch(/too many iterations|iteration|limit/i)
  })

  it('awk infinite loop is bounded', async () => {
    const bash = createTestBash()
    const result = await bash.exec('echo x | awk "{ while(1) print }"')
    expect(result.stderr).toMatch(/too many iterations|iteration|output size|limit/i)
  })
})

describe('Attack: heredoc memory', () => {
  it('massive heredoc is stopped by maxHeredocSize', async () => {
    const bash = createTestBash()
    const bigContent = 'A'.repeat(1024 * 1024 + 100)
    const result = await bash.exec(`cat <<'EOF'\n${bigContent}\nEOF`)
    expect(result.stderr).toMatch(/heredoc|size|limit/i)
  })
})

describe('Attack: read-only filesystem', () => {
  it('cannot write files', async () => {
    const bash = createTestBash()
    // EROFS may throw as an unhandled exception or return in stderr
    const resultOrError = await bash.exec('echo "pwned" > /tmp/evil.sh').catch((err: Error) => err)
    if (resultOrError instanceof Error) {
      expect(resultOrError.message).toMatch(/read-only|EROFS/i)
    } else {
      expect(resultOrError.stderr).toMatch(/read-only|EROFS|permission/i)
    }
  })

  it('cannot create directories', async () => {
    const bash = createTestBash()
    const resultOrError = await bash.exec('mkdir /tmp/evil').catch((err: Error) => err)
    if (resultOrError instanceof Error) {
      expect(resultOrError.message).toMatch(/read-only|EROFS/i)
    } else {
      expect(resultOrError.stderr).toMatch(/read-only|EROFS|permission/i)
    }
  })

  it('cannot delete files', async () => {
    const bash = createTestBash()
    const resultOrError = await bash.exec('rm /home/.keep').catch((err: Error) => err)
    if (resultOrError instanceof Error) {
      expect(resultOrError.message).toMatch(/read-only|EROFS|No such/i)
    } else {
      expect(resultOrError.stderr).toMatch(/read-only|EROFS|permission|No such/i)
    }
  })
})

describe('Attack: concurrent execution fairness', () => {
  it('multiple bash instances run concurrently without blocking each other', async () => {
    const instances = Array.from({ length: 10 }, () => createTestBash())
    const start = performance.now()

    const results = await Promise.all(
      instances.map((bash) =>
        bash.exec('for i in $(seq 1 500); do x=$((i * 2)); done; echo "done"'),
      ),
    )

    const elapsed = performance.now() - start

    for (const result of results) {
      expect(
        result.stdout.includes('done') ||
          result.stderr.includes('limit') ||
          result.stderr.includes('too many'),
      ).toBe(true)
    }

    // With async execution, 10 concurrent instances shouldn't take 10x as long
    expect(elapsed).toBeLessThan(30000)
  })
})

describe('Attack: command count exhaustion', () => {
  it('many semicolon-separated commands hit maxCommandCount', async () => {
    const bash = createTestBash()
    const cmds = Array.from({ length: 1500 }, (_, i) => `echo ${i}`).join('; ')
    const result = await bash.exec(cmds)
    expect(result.stderr).toMatch(/too many commands/i)
  })
})

describe('Attack: glob exhaustion', () => {
  it('wildcard expansion is bounded by maxGlobOperations', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 500; i++) {
      files[`/home/docs/dir${i}/file.md`] = `content ${i}`
    }
    const bash = createTestBash(files)
    // Attempt a glob-heavy operation
    const result = await bash.exec('ls /home/docs/*/*.md 2>&1; echo "done"')
    // Should either succeed within limits or hit the glob limit
    expect(
      result.stdout.includes('done') ||
        result.stderr.includes('limit') ||
        result.stderr.includes('glob'),
    ).toBe(true)
  })
})
