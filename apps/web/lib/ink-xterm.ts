/**
 * Bridges Ink (React for CLIs) to xterm.js in the browser.
 * Replaces ink-web's mountInkInXterm with correct sizing and no filterStdoutChunk hack.
 */

import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { render } from 'ink'
import type { ReactNode } from 'react'
import { setMarkdownWidth } from '../components/ui/chat'

// Minimal EventEmitter for stream shims (Ink expects Node-like streams)
class EventEmitter {
  private _listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(event: string, fn: (...args: unknown[]) => void) {
    let set = this._listeners.get(event)
    if (!set) {
      set = new Set()
      this._listeners.set(event, set)
    }
    set.add(fn)
    return this
  }
  addListener(event: string, fn: (...args: unknown[]) => void) {
    return this.on(event, fn)
  }
  off(event: string, fn: (...args: unknown[]) => void) {
    this._listeners.get(event)?.delete(fn)
    return this
  }
  removeListener(event: string, fn: (...args: unknown[]) => void) {
    return this.off(event, fn)
  }
  once(event: string, fn: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped)
      fn(...args)
    }
    return this.on(event, wrapped)
  }
  emit(event: string, ...args: unknown[]) {
    const set = this._listeners.get(event)
    if (!set?.size) return false
    for (const fn of [...set]) fn(...args)
    return true
  }
  removeAllListeners() {
    this._listeners.clear()
    return this
  }
  setMaxListeners() {
    return this
  }
  getMaxListeners() {
    return Infinity
  }
  listenerCount(event: string) {
    return this._listeners.get(event)?.size ?? 0
  }
  getListeners(event: string) {
    return [...(this._listeners.get(event) ?? [])]
  }
  rawListeners(event: string) {
    return this.getListeners(event)
  }
  eventNames() {
    return [...this._listeners.keys()]
  }
  prependListener(event: string, fn: (...args: unknown[]) => void) {
    return this.on(event, fn)
  }
  prependOnceListener(event: string, fn: (...args: unknown[]) => void) {
    return this.once(event, fn)
  }
}

// xterm.js v6 synchronized update sequences
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

/** Writable shim - pipes Ink's output to xterm.js, wrapping everything in synchronized updates */
function createStdout(term: Terminal) {
  const emitter = new EventEmitter()
  let pending = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  // Batch all writes into a single synchronized frame per microtask
  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (pending.length > 0) {
        term.write(BSU + pending + ESU)
        pending = ''
      }
    }, 0)
  }

  const stdout = Object.assign(emitter, {
    writable: true,
    isTTY: true,
    columns: term.cols,
    rows: term.rows,
    write(chunk: unknown, encoding?: unknown, cb?: () => void) {
      const str = typeof chunk === 'string' ? chunk : String(chunk)
      if (str.length > 0) {
        // Strip Ink's own BSU/ESU - we manage synchronization ourselves
        pending += str.replaceAll(BSU, '').replaceAll(ESU, '')
        scheduleFlush()
      }
      if (typeof encoding === 'function') encoding()
      else cb?.()
      return true
    },
    end() {
      emitter.emit('end')
    },
    cork() {},
    uncork() {},
    setDefaultEncoding() {
      return stdout
    },
  })
  return stdout
}

/** Readable shim - pipes xterm.js input to Ink */
function createStdin(term: Terminal) {
  const emitter = new EventEmitter()
  const buffer: string[] = []

  term.onData((data) => {
    buffer.push(data)
    emitter.emit('readable')
  })

  const stdin = Object.assign(emitter, {
    isTTY: true,
    columns: term.cols,
    rows: term.rows,
    setEncoding() {},
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read() {
      return buffer.length > 0 ? buffer.shift() : null
    },
  })
  return stdin
}

export interface MountOptions {
  container: HTMLElement
  focus?: boolean
  termOptions?: ConstructorParameters<typeof Terminal>[0]
}

export interface MountResult {
  term: Terminal
  rerender: (node: ReactNode) => void
  unmount: () => void
}

/** Wait for Yoga WASM to initialize (set by ink-web's index.js via the `ink` alias). */
async function waitForYoga() {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.__yogaPromise) await (g.__yogaPromise as Promise<unknown>)
}

/** Mount an Ink component inside an xterm.js terminal attached to a DOM container. */
export async function mountInk(element: ReactNode, opts: MountOptions): Promise<MountResult> {
  // Polyfill setImmediate (Ink uses it internally)
  if (typeof globalThis.setImmediate === 'undefined') {
    ;(globalThis as unknown as Record<string, unknown>).setImmediate = (
      fn: () => void,
      ...args: unknown[]
    ) => setTimeout(fn, 0, ...args)
  }

  const term = new Terminal({
    convertEol: true,
    disableStdin: false,
    ...opts.termOptions,
  })

  term.open(opts.container)

  // FitAddon measures actual char width and sets correct cols/rows before first render
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank', 'noopener')
    }),
  )
  fitAddon.fit()
  setMarkdownWidth(term.cols)

  // Hide cursor (Ink draws its own)
  term.write('\x1b[?25l')

  if (opts.focus !== false) {
    setTimeout(() => {
      try {
        term.focus()
      } catch {}
    }, 100)
  }

  const stdout = createStdout(term)
  const stdin = createStdin(term)

  // Sync stream dimensions with terminal
  const syncSize = () => {
    stdout.columns = term.cols
    stdout.rows = term.rows
    stdin.columns = term.cols
    stdin.rows = term.rows
    stdout.emit('resize')
    setMarkdownWidth(term.cols)
  }

  // Yoga WASM must be ready before Ink can render
  await waitForYoga()

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  // Resize: debounce, clear screen on narrowing (Ink can't track wrapped lines)
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      try {
        const prevCols = term.cols
        const prevRows = term.rows
        fitAddon.fit()
        if (term.cols !== prevCols || term.rows !== prevRows) {
          if (term.cols < prevCols) {
            // Narrowing: Ink's line-by-line erase misses wrapped lines.
            // Full clear + cursor home so Ink redraws cleanly.
            instance.clear()
            term.write('\x1b[2J\x1b[H')
          }
          syncSize()
        }
      } catch {}
    }, 16)
  })
  ro.observe(opts.container)

  return {
    term,
    rerender(node: ReactNode) {
      instance.rerender(node)
    },
    unmount() {
      try {
        instance.unmount()
      } catch {}
      ro.disconnect()
      term.dispose()
    },
  }
}
