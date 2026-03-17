/**
 * Shell completion engine - ported from bash 5.3 bashline.c.
 *
 * just-bash's exec() is stateless (like bash -c) so programmable completion
 * via compspecs is not viable. Instead we port bash's orchestration logic
 * and add a JS completion hook for per-command argument completion.
 *
 * See createCompletionEngine() for the pipeline.
 */

import { posix } from 'node:path'
import type { Bash } from 'just-bash'

type CompletionResult = [completions: string[], word: string]

/** Per-command argument completion hook. Return completions, or empty to fall back. */
export type CommandCompleteFn = (ctx: {
  command: string
  args: string[]
  word: string
  cwd: string
}) => Promise<string[]>

/** Command separators that indicate the next token is a new command. Ref: bashline.c COMMAND_SEPARATORS */
const COMMAND_SEPARATORS = new Set([';', '|', '&', '(', '`'])

/**
 * Parse the current line to extract completion context.
 * Determines the current word and whether we're in command position.
 *
 * Ref: attempt_shell_completion() lines 1610-1660 in bashline.c
 */
export function parseCompletionContext(line: string) {
  // Find the start of the current command by scanning for the last unmatched
  // command separator. Mirrors bash's find_cmd_start() which uses skip_to_delim
  // with COMMAND_SEPARATORS to locate where the current command begins.
  // This ensures `echo $(custom-cmd arg<tab>` completes for `custom-cmd`, not `echo`.
  const cmdStart = findCmdStart(line)
  const cmdLine = line.slice(cmdStart)

  const trimmed = cmdLine.trimStart()
  const parts = trimmed.split(/\s+/)
  const word = cmdLine.endsWith(' ') ? '' : parts[parts.length - 1] ?? ''

  // Walk backwards from cursor to find preceding non-whitespace char.
  // This mirrors bash's `ti = start - 1; while (whitespace(...)) ti--` loop.
  let ti = cmdLine.length - word.length - 1
  while (ti >= 0 && (cmdLine[ti] === ' ' || cmdLine[ti] === '\t')) ti--

  let inCommandPosition = false

  if (ti < 0) {
    // Nothing before the word - we're at the start of the command
    inCommandPosition = true
  } else if (COMMAND_SEPARATORS.has(cmdLine[ti])) {
    // Preceded by a command separator like ; | & ( `
    inCommandPosition = true
  }

  const command = parts[0] ?? ''
  const args = parts.length > 1 ? parts.slice(1) : []

  return { word, command, args, inCommandPosition }
}

/**
 * Find where the current command starts by scanning for the last
 * unmatched command separator. Mirrors bash's find_cmd_start().
 *
 * Ref: bashline.c find_cmd_start() lines 1465-1520
 */
export function findCmdStart(line: string): number {
  let start = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    // Skip quoted strings
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1)
      if (close !== -1) i = close
      continue
    }
    if (COMMAND_SEPARATORS.has(ch)) {
      start = i + 1
    }
  }
  return start
}

/**
 * Shell-quote a string for safe interpolation into a compgen command.
 * Only handles single-quote wrapping since compgen args are simple prefixes.
 */
export function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Generate completion matches via just-bash's compgen builtin. Mirrors the C-internal compgen calls in bashline.c. */
async function compgen(bash: Bash, action: string, prefix: string, cwd: string): Promise<string[]> {
  const result = await bash.exec(`compgen -A ${action} -- ${shellQuote(prefix)}`, { cwd })
  if (result.exitCode !== 0 || !result.stdout.trim()) return []
  return result.stdout.trim().split('\n').filter(Boolean)
}

export interface CompletionEngine {
  complete(line: string, cwd: string): Promise<CompletionResult>
}

/**
 * Create a completion engine that follows bash's completion pipeline.
 *
 * Pipeline:
 *   1. Syntax-aware special cases (e.g. $) - always wins, not overridable
 *   2. Command position -> command names
 *   3. Custom JS completion hook (per-command argument completion)
 *   4. Fallback -> file/directory names
 */
export function createCompletionEngine(
  bash: Bash,
  completeFn?: CommandCompleteFn
): CompletionEngine {
  return {
    async complete(line: string, cwd: string): Promise<CompletionResult> {
      const ctx = parseCompletionContext(line)

      // Syntax-aware special cases - always take priority (matches real bash).
      // These are hardcoded in bash_default_completion and can't be overridden.
      const syntaxHits = await completeSyntaxAware(bash, ctx.word, cwd)
      if (syntaxHits) return [syntaxHits, ctx.word]

      // Command position -> command names
      if (ctx.inCommandPosition) {
        return completeCommands(bash, ctx.word, cwd)
      }

      // Custom JS completion hook - analogous to complete -F but in JS.
      // Needed because just-bash exec() is stateless so bash-native
      // programmable completion (compspecs) can't persist across calls.
      if (completeFn) {
        const hits = await completeFn({
          command: ctx.command,
          args: ctx.args,
          word: ctx.word,
          cwd,
        })
        if (hits.length > 0) return [hits, ctx.word]
      }

      // Fallback: file/directory completion
      return completeFiles(bash, ctx.word, cwd)
    },
  }
}

/**
 * Syntax-aware special cases - ported from bash_default_completion().
 * These always take priority and can't be overridden.
 * Returns null if no special case matches.
 *
 * Ref: bashline.c lines 1836-1870
 */
async function completeSyntaxAware(
  bash: Bash,
  word: string,
  cwd: string
): Promise<string[] | null> {
  // --- $ prefix: variable names ---
  // Ref: bashline.c lines 1836-1862
  // Note: $( and ` are handled by findCmdStart splitting at ( and ` separators,
  // which puts the next token in command position. Only $VAR and ${VAR} reach here.
  if (word.startsWith('$')) {
    if (word.startsWith('${')) {
      // Parameter expansion: ${PAT<tab> -> complete with closing }
      const hits = (await compgen(bash, 'variable', word.slice(2), cwd)).map((v) => '${' + v + '}')
      return formatHits(hits)
    }
    // Plain $VAR completion
    const hits = (await compgen(bash, 'variable', word.slice(1), cwd)).map((v) => '$' + v)
    return formatHits(hits)
  }

  // --- ~ prefix: username completion ---
  // Ref: bashline.c line 1865
  // No-op in sandboxed environment (no real users).

  // --- @ prefix: hostname completion ---
  // Ref: bashline.c line 1870
  // No-op in sandboxed environment (no real hosts).

  return null
}

/**
 * Command name completion.
 * Ref: bashline.c lines 1875-1920
 */
async function completeCommands(bash: Bash, word: string, cwd: string): Promise<CompletionResult> {
  const hits = await compgen(bash, 'command', word, cwd)
  return [formatHits(hits), word]
}

/**
 * File/directory completion.
 * Appends / to directories, space to sole file matches (matching readline behavior).
 */
async function completeFiles(bash: Bash, word: string, cwd: string): Promise<CompletionResult> {
  // Expand ~ to $HOME for fs lookup, preserve ~/prefix in displayed completions
  let tildePrefix = ''
  let expanded = word
  const home = bash.getEnv().HOME
  if (home && (word === '~' || word.startsWith('~/'))) {
    tildePrefix = word.startsWith('~/') ? '~/' : '~'
    expanded = home + word.slice(1)
  }

  const lastSlash = expanded.lastIndexOf('/')
  const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : ''
  const namePart = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded
  const searchDir = dirPart ? posix.resolve(cwd, dirPart) : cwd

  try {
    const entries = await bash.fs.readdir(searchDir)
    const matches = entries.filter((e) => e.startsWith(namePart)).map((e) => dirPart + e)

    const decorated = await Promise.all(
      matches.map(async (match) => {
        try {
          const fullPath = posix.resolve(cwd, match)
          const stat = await bash.fs.stat(fullPath)
          // Restore ~/prefix for display
          const display = tildePrefix
            ? tildePrefix + match.slice(home!.length + (tildePrefix === '~/' ? 1 : 0))
            : match
          if (stat.isDirectory) return display + '/'
          return matches.length === 1 ? display + ' ' : display
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

/** Append a suffix to a sole completion match (readline convention). Defaults to trailing space. */
export function formatHits(hits: string[], singleSuffix = ' '): string[] {
  if (hits.length === 1) return [hits[0] + singleSuffix]
  return hits
}
