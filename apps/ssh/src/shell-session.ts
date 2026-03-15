import { posix } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Bash } from 'just-bash'

type CompletionResult = [string[], string]

/** Per-command argument completion hook. Return completions, or empty to fall back to file completion. */
export type CommandCompleteFn = (ctx: {
  command: string
  args: string[]
  word: string
  cwd: string
}) => Promise<string[]>

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
}

/** Interactive shell session - REPL loop with readline, cwd tracking, and tab completion. */
export class ShellSession {
  #rl: Interface
  #cwd: string
  #bash: Bash
  #commands: string[]
  #promptFn: (cwd: string) => string
  #completeFn?: CommandCompleteFn
  #onExit?: () => void
  #onLine?: (command: string) => boolean | void
  #output: Writable

  private constructor(opts: ShellSessionOptions, commands: string[]) {
    this.#bash = opts.bash
    this.#cwd = opts.bash.getCwd()
    this.#commands = commands
    this.#promptFn = opts.prompt
    this.#completeFn = opts.complete
    this.#onExit = opts.onExit
    this.#onLine = opts.onLine
    this.#output = opts.output

    this.#rl = createInterface({
      input: opts.input,
      output: opts.output,
      prompt: opts.prompt(this.#cwd),
      terminal: opts.terminal,
      completer: (line: string, cb: (err: null, result: CompletionResult) => void) => {
        this.#complete(line)
          .then((result) => cb(null, result))
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

  /** Create a new shell session. Discovers available commands via compgen. */
  static async create(opts: ShellSessionOptions): Promise<ShellSession> {
    const result = await opts.bash.exec('compgen -A command')
    const commands = result.stdout.trim().split('\n')
    return new ShellSession(opts, commands)
  }

  /** Built-in completion pipeline: commands -> per-command hook -> file/dir fallback. */
  async #complete(line: string): Promise<CompletionResult> {
    const parts = line.trimStart().split(/\s+/)
    const word = parts[parts.length - 1] ?? ''

    // First word - complete command names
    if (parts.length <= 1) {
      const hits = this.#commands.filter((c) => c.startsWith(word))
      return [hits.length === 1 ? [hits[0] + ' '] : hits, word]
    }

    // Per-command hook - if provided and returns results, use them
    if (this.#completeFn) {
      const command = parts[0]
      const hits = await this.#completeFn({ command, args: parts.slice(1), word, cwd: this.#cwd })
      if (hits.length > 0) return [hits, word]
    }

    // Fallback - file/directory completion
    return this.#completeFiles(word)
  }

  async #completeFiles(word: string): Promise<CompletionResult> {
    const lastSlash = word.lastIndexOf('/')
    const dirPart = lastSlash >= 0 ? word.slice(0, lastSlash + 1) : ''
    const namePart = lastSlash >= 0 ? word.slice(lastSlash + 1) : word
    const searchDir = dirPart ? posix.resolve(this.#cwd, dirPart) : this.#cwd

    try {
      const entries = await this.#bash.fs.readdir(searchDir)
      const matches = entries.filter((e) => e.startsWith(namePart)).map((e) => dirPart + e)

      const decorated = await Promise.all(
        matches.map(async (match) => {
          try {
            const fullPath = posix.resolve(this.#cwd, match)
            const stat = await this.#bash.fs.stat(fullPath)
            if (stat.isDirectory) return match + '/'
            return matches.length === 1 ? match + ' ' : match
          } catch {
            return match
          }
        })
      )

      return [decorated, word]
    } catch {
      return [[], word]
    }
  }

  async #handleLine(line: string) {
    const command = line.trim()

    if (this.#onLine) {
      const result = this.#onLine(command)
      if (result === false) return
    }

    if (command) {
      try {
        const result = await this.#bash.exec(command, { cwd: this.#cwd })
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
