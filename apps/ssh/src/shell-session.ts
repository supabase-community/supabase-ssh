import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Bash } from 'just-bash'
import { createCompletionEngine, type CompletionEngine } from './completion.js'
import type { CommandCompleteFn } from './completion.js'

export type { CommandCompleteFn } from './completion.js'

type CompletionResult = [string[], string]

export interface ShellSessionOptions {
  bash: Bash
  input: Readable
  output: Writable
  terminal: boolean
  /** Dynamic prompt - receives current cwd. */
  prompt: (cwd: string) => string
  /** Optional banner written before the first prompt. */
  banner?: string
  /** Per-command argument completion. Falls back to file/dir completion when unset or returns empty. */
  complete?: CommandCompleteFn
  /** Called when the session ends (Ctrl+D or stream closes). */
  onExit?: () => void
  /** Called on each line before execution. Return false to skip exec (e.g. for 'exit' handling). */
  onLine?: (command: string) => boolean | void
  /** Per-command execution timeout in ms. When set, each exec gets an AbortSignal. */
  execTimeout?: number
}

/** Interactive shell session - REPL loop with readline, cwd tracking, and tab completion. */
export class ShellSession {
  #rl: Interface
  #cwd: string
  #bash: Bash
  #completion: CompletionEngine
  #promptFn: (cwd: string) => string
  #onExit?: () => void
  #onLine?: (command: string) => boolean | void
  #output: Writable
  #execTimeout?: number

  constructor(opts: ShellSessionOptions) {
    this.#bash = opts.bash
    this.#cwd = opts.bash.getCwd()
    this.#promptFn = opts.prompt
    this.#completion = createCompletionEngine(opts.bash, opts.complete)
    this.#onExit = opts.onExit
    this.#onLine = opts.onLine
    this.#output = opts.output
    this.#execTimeout = opts.execTimeout

    this.#rl = createInterface({
      input: opts.input,
      output: opts.output,
      prompt: opts.prompt(this.#cwd),
      terminal: opts.terminal,
      completer: (line: string, cb: (err: null, result: CompletionResult) => void) => {
        this.#completion
          .complete(line, this.#cwd)
          .then((r) => cb(null, r))
          .catch(() => cb(null, [[], line]))
      },
    })

    this.#rl.on('line', (line) => this.#handleLine(line))
    this.#rl.on('close', () => this.#onExit?.())
    this.#rl.on('SIGINT', () => {
      this.#output.write('^C\r\n')
      this.#rl.prompt()
    })

    if (opts.banner) {
      opts.output.write(opts.banner)
    }

    this.#rl.prompt()
  }

  async #handleLine(line: string) {
    const command = line.trim()

    if (this.#onLine) {
      const result = this.#onLine(command)
      if (result === false) return
    }

    if (command) {
      try {
        const signal = this.#execTimeout
          ? AbortSignal.timeout(this.#execTimeout)
          : undefined
        const result = await this.#bash.exec(command, { cwd: this.#cwd, signal })
        if (result.stdout) this.#output.write(result.stdout.replace(/\n/g, '\r\n'))
        if (result.stderr) this.#output.write(result.stderr.replace(/\n/g, '\r\n'))
        if (result.env.PWD) this.#cwd = result.env.PWD
      } catch (err) {
        this.#output.write(`Error: ${err instanceof Error ? err.message : String(err)}\r\n`)
      }
    }

    this.#rl.setPrompt(this.#promptFn(this.#cwd))
    this.#rl.prompt()
  }

  close() {
    this.#rl.close()
  }
}
