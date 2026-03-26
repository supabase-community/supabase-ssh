/** Parse OTel collector JSONL output into a SessionProfile. */
import { readFileSync, writeFileSync } from 'node:fs'
import type { CommandSpec, SessionProfile } from '../profiles/types.js'

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

/** Parse spans JSONL into a SessionProfile and write to disk. */
export function parseProfile(inputPath: string, outputPath: string): SessionProfile | null {
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

  // Filter for ssh.command spans, excluding 'agents' (setup command, not agent behavior)
  const commandSpans = allSpans
    .filter((s) => s.name === 'ssh.command' && getAttr(s, 'ssh.command.text') !== 'agents')
    .sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1))

  if (commandSpans.length === 0) {
    console.warn('No ssh.command spans found in input')
    return null
  }

  console.log(`Found ${commandSpans.length} command spans`)

  // Convert to profile commands with offsets from session start
  const sessionStart = BigInt(commandSpans[0].startTimeUnixNano)
  const commands: CommandSpec[] = commandSpans.map((span) => ({
    command: getAttr(span, 'ssh.command.text') ?? '',
    offset: Number((BigInt(span.startTimeUnixNano) - sessionStart) / 1_000_000n),
  }))

  const profile: SessionProfile = {
    name: 'captured-agent',
    description: `Captured from real agent session (${commands.length} commands)`,
    commands,
  }

  writeFileSync(outputPath, `${JSON.stringify(profile, null, 2)}\n`)
  console.log(`\nProfile written to: ${outputPath}`)
  for (const cmd of commands) {
    console.log(`  [${(cmd.offset / 1000).toFixed(1)}s] ${cmd.command.slice(0, 80)}`)
  }

  return profile
}
