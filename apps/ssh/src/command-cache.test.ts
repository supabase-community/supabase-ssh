import type { BashExecResult } from 'just-bash'
import { describe, expect, it } from 'vitest'
import { CommandCache } from './command-cache.js'

function makeResult(stdout: string, exitCode = 0): BashExecResult {
  return { stdout, stderr: '', exitCode, env: {} }
}

describe('CommandCache', () => {
  it('returns undefined on cache miss', () => {
    const cache = new CommandCache()
    expect(cache.get('/supabase', 'ls')).toBeUndefined()
  })

  it('returns cached result on hit', () => {
    const cache = new CommandCache()
    const result = makeResult('file.txt\n')
    cache.set('/supabase', 'ls', result)
    expect(cache.get('/supabase', 'ls')).toEqual(result)
  })

  it('differentiates by cwd', () => {
    const cache = new CommandCache()
    const r1 = makeResult('docs output')
    const r2 = makeResult('guides output')
    cache.set('/supabase/docs', 'ls', r1)
    cache.set('/supabase/docs/guides', 'ls', r2)

    expect(cache.get('/supabase/docs', 'ls')).toEqual(r1)
    expect(cache.get('/supabase/docs/guides', 'ls')).toEqual(r2)
  })

  it('tracks hit/miss stats', () => {
    const cache = new CommandCache()
    cache.set('/supabase', 'ls', makeResult('file.txt\n'))

    cache.get('/supabase', 'ls')
    cache.get('/supabase', 'ls')
    cache.get('/supabase', 'cat foo')

    expect(cache.stats).toEqual({
      entries: 1,
      hits: 2,
      misses: 1,
      hitRate: 2 / 3,
    })
  })

  it('evicts oldest entry when at capacity', () => {
    const cache = new CommandCache({ maxEntries: 2 })
    cache.set('/supabase', 'a', makeResult('a'))
    cache.set('/supabase', 'b', makeResult('b'))
    cache.set('/supabase', 'c', makeResult('c'))

    expect(cache.get('/supabase', 'a')).toBeUndefined()
    expect(cache.get('/supabase', 'b')).toBeDefined()
    expect(cache.get('/supabase', 'c')).toBeDefined()
  })

  it('promotes entry on access (LRU)', () => {
    const cache = new CommandCache({ maxEntries: 2 })
    cache.set('/supabase', 'a', makeResult('a'))
    cache.set('/supabase', 'b', makeResult('b'))

    // Access 'a' to promote it
    cache.get('/supabase', 'a')

    // 'b' is now oldest, should be evicted
    cache.set('/supabase', 'c', makeResult('c'))
    expect(cache.get('/supabase', 'a')).toBeDefined()
    expect(cache.get('/supabase', 'b')).toBeUndefined()
    expect(cache.get('/supabase', 'c')).toBeDefined()
  })

  it('skips caching output exceeding maxOutputBytes', () => {
    const cache = new CommandCache({ maxOutputBytes: 10 })
    cache.set('/supabase', 'big', makeResult('x'.repeat(100)))

    expect(cache.get('/supabase', 'big')).toBeUndefined()
    expect(cache.stats.entries).toBe(0)
  })

  it('does not evict when updating existing entry', () => {
    const cache = new CommandCache({ maxEntries: 2 })
    cache.set('/supabase', 'a', makeResult('v1'))
    cache.set('/supabase', 'b', makeResult('v2'))

    // Overwrite 'a' - should not evict 'b'
    cache.set('/supabase', 'a', makeResult('v3'))

    expect(cache.get('/supabase', 'a')?.stdout).toBe('v3')
    expect(cache.get('/supabase', 'b')).toBeDefined()
    expect(cache.stats.entries).toBe(2)
  })
})
