import type { BashExecResult } from 'just-bash'

export interface CommandCacheOptions {
  maxEntries?: number
  maxOutputBytes?: number
}

export interface CommandCacheStats {
  entries: number
  hits: number
  misses: number
  hitRate: number
}

/** In-memory LRU cache for command output. Safe because the VFS is read-only. */
export class CommandCache {
  #cache = new Map<string, BashExecResult>()
  #maxEntries: number
  #maxOutputBytes: number
  #hits = 0
  #misses = 0

  constructor(opts?: CommandCacheOptions) {
    this.#maxEntries = opts?.maxEntries ?? 1000
    this.#maxOutputBytes = opts?.maxOutputBytes ?? 512 * 1024 // skip caching outputs > 512KB
  }

  static #key(cwd: string, command: string): string {
    return `${cwd}\0${command}`
  }

  get(cwd: string, command: string): BashExecResult | undefined {
    const key = CommandCache.#key(cwd, command)
    const entry = this.#cache.get(key)
    if (entry) {
      this.#hits++
      // Move to end (most recently used)
      this.#cache.delete(key)
      this.#cache.set(key, entry)
      return entry
    }
    this.#misses++
    return undefined
  }

  set(cwd: string, command: string, result: BashExecResult): void {
    const key = CommandCache.#key(cwd, command)
    const outputBytes = Buffer.byteLength(result.stdout ?? '') + Buffer.byteLength(result.stderr ?? '')
    if (outputBytes > this.#maxOutputBytes) return

    // Evict oldest if at capacity
    if (this.#cache.size >= this.#maxEntries && !this.#cache.has(key)) {
      const oldest = this.#cache.keys().next()
      if (!oldest.done) this.#cache.delete(oldest.value)
    }

    this.#cache.set(key, result)
  }

  get stats(): CommandCacheStats {
    return {
      entries: this.#cache.size,
      hits: this.#hits,
      misses: this.#misses,
      hitRate: this.#hits + this.#misses > 0 ? this.#hits / (this.#hits + this.#misses) : 0,
    }
  }
}
