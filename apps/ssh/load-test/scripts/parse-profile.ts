/**
 * Parse OTel collector JSON output into a SessionProfile.
 *
 * Usage: pnpm tsx load-test/scripts/parse-profile.ts [input] [output]
 *   input:  Path to collector spans JSON (default: load-test/traces/spans.json)
 *   output: Path to write profile (default: load-test/profiles/captured-agent.json)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionProfile, CommandSpec } from '../profiles/types.js'

interface OTLPSpan {
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>
}

interface OTLPResourceSpans {
  resourceSpans: Array<{
    scopeSpans: Array<{
      spans: OTLPSpan[]
    }>
  }>
}

function getAttr(span: OTLPSpan, key: string): string | undefined {
  const attr = span.attributes.find((a) => a.key === key)
  return attr?.value.stringValue ?? attr?.value.intValue
}

function main() {
  const args = process.argv.slice(2)
  const inputPath = resolve(args[0] ?? 'load-test/traces/spans.json')
  const outputPath = resolve(args[1] ?? 'load-test/profiles/captured-agent.json')

  console.log(`Reading spans from: ${inputPath}`)

  const raw = readFileSync(inputPath, 'utf-8')

  // The file exporter writes one JSON object per line (JSONL)
  const allSpans: OTLPSpan[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const data = JSON.parse(line) as OTLPResourceSpans
      for (const rs of data.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) {
          allSpans.push(...(ss.spans ?? []))
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  // Filter for ssh.command spans
  const commandSpans = allSpans
    .filter((s) => s.name === 'ssh.command')
    .sort((a, b) => BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1)

  if (commandSpans.length === 0) {
    console.error('No ssh.command spans found in input')
    process.exit(1)
  }

  // Group by session ID
  const sessions = new Map<string, OTLPSpan[]>()
  for (const span of commandSpans) {
    const sessionId = getAttr(span, 'ssh.session.id') ?? 'unknown'
    const existing = sessions.get(sessionId) ?? []
    existing.push(span)
    sessions.set(sessionId, existing)
  }

  console.log(`Found ${commandSpans.length} command spans across ${sessions.size} sessions`)

  // Pick the longest session
  let bestSession: OTLPSpan[] = []
  for (const spans of sessions.values()) {
    if (spans.length > bestSession.length) {
      bestSession = spans
    }
  }

  // Convert to profile commands with think times
  const commands: CommandSpec[] = []
  for (let i = 0; i < bestSession.length; i++) {
    const span = bestSession[i]
    const commandText = getAttr(span, 'ssh.command.text') ?? ''

    let thinkTimeMs = 0
    if (i > 0) {
      const prevEnd = BigInt(bestSession[i - 1].endTimeUnixNano)
      const thisStart = BigInt(span.startTimeUnixNano)
      thinkTimeMs = Math.max(0, Number((thisStart - prevEnd) / 1_000_000n))
    }

    commands.push({ command: commandText, thinkTimeMs })
  }

  const profile: SessionProfile = {
    name: 'captured-agent',
    description: `Captured from real agent session (${commands.length} commands)`,
    commands,
  }

  writeFileSync(outputPath, JSON.stringify(profile, null, 2) + '\n')
  console.log(`\nProfile written to: ${outputPath}`)
  console.log(`Commands: ${commands.length}`)
  for (const cmd of commands) {
    console.log(`  [+${cmd.thinkTimeMs}ms] ${cmd.command.slice(0, 80)}`)
  }
}

main()
