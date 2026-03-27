import { openai } from '@ai-sdk/openai'
import { convertToModelMessages, stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { executeBashCommand } from '@/lib/bash-tool'

export const maxDuration = 30

const hasKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

async function getRateLimit() {
  if (!hasKv) return null
  const { Ratelimit } = await import('@upstash/ratelimit')
  const { kv } = await import('@vercel/kv')
  return new Ratelimit({
    redis: kv,
    limiter: Ratelimit.fixedWindow(50_000, '30m'),
    prefix: 'ratelimit:chat:tokens',
  })
}

const SYSTEM_PROMPT = `You are a Supabase documentation assistant. You help users find and understand Supabase docs.

You have access to a bash tool. To search and read Supabase docs, use:

  ssh supabase.sh <command>

Examples:
  ssh supabase.sh grep -rl 'auth' /supabase/docs/
  ssh supabase.sh cat /supabase/docs/guides/auth/passwords.md
  ssh supabase.sh find /supabase/docs/guides/database -name '*.md'
  ssh supabase.sh grep -r 'RLS' /supabase/docs/guides/auth --include='*.md' -l

All docs live under /supabase/docs/ as markdown files. Use standard Unix tools (grep, find, cat, head, etc.) to search and read them.

Be concise and helpful. When answering questions, first search for relevant docs, then read the most relevant ones, and synthesize a clear answer.`

/** POST /api/chat - streaming AI chat with bash tool for docs search */
export async function POST(req: Request) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'

  const rateLimit = await getRateLimit()
  if (rateLimit) {
    const { remaining } = await rateLimit.getRemaining(ip)
    if (remaining <= 0) {
      return new Response('Rate limited', { status: 429 })
    }
  }

  const { messages } = await req.json()
  const modelMessages = await convertToModelMessages(messages)

  const result = streamText({
    model: openai('gpt-5.4-mini'),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    providerOptions: {
      openai: { store: false },
    },
    stopWhen: stepCountIs(10),
    tools: {
      bash: tool({
        description: 'Execute a bash command to search and read Supabase docs',
        inputSchema: z.object({
          command: z.string().describe('The bash command to execute'),
        }),
        execute: async (input) => {
          const result = await executeBashCommand(input.command)
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          }
        },
      }),
    },
    onFinish: async ({ usage }) => {
      const rl = await getRateLimit()
      if (rl) {
        await rl.limit(ip, {
          rate: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        })
      }
    },
  })

  return result.toUIMessageStreamResponse()
}
