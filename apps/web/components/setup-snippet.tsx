'use client'

import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CodeBlock } from './code-block'

const TOOLS = [
  { label: 'Claude Code', file: 'CLAUDE.md', command: 'ssh supabase.sh setup | claude' },
  { label: 'Codex', file: 'AGENTS.md', command: 'codex "$(ssh supabase.sh setup)"' },
  { label: 'Cursor', file: 'AGENTS.md', command: 'agent "$(ssh supabase.sh setup)"' },
  { label: 'OpenCode', file: 'AGENTS.md', command: 'opencode --prompt "$(ssh supabase.sh setup)"' },
  { label: 'Gemini', file: 'GEMINI.md', command: 'gemini "$(ssh supabase.sh setup)"' },
  { label: 'Copilot', file: 'AGENTS.md', command: 'copilot -i "$(ssh supabase.sh setup)"' },
] as const

const TRY_COMMAND = 'ssh supabase.sh'

/** Setup snippet with try command, agent dropdown, and auto/manual install. */
export function SetupSnippet() {
  const [selectedTool, setSelectedTool] = useState(0)

  const tool = TOOLS[selectedTool] ?? TOOLS[0]
  const appendCommand = `ssh supabase.sh agents >> ${tool.file}`

  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-10">
      <div className="flex flex-col items-center gap-4 max-w-lg mx-auto w-full">
        <p className="font-mono text-sm text-[#888]">Browse Supabase docs over SSH:</p>
        <div className="w-full">
          <CodeBlock copyText={TRY_COMMAND}>
            <span className="text-[#3ecf8e] select-none mr-1">$ </span>
            <span className="text-[#ccc]">{TRY_COMMAND}</span>
          </CodeBlock>
        </div>
      </div>

      {/* Setup group with dotted border */}
      <div className="border border-dashed border-[#3ecf8e] rounded-lg p-10 flex flex-col gap-4 max-w-lg mx-auto w-full mt-2">
        <p className="text-center font-mono text-sm text-[#888] mb-6">
          Give{' '}
          <DropdownMenu>
            <DropdownMenuTrigger className="text-white hover:text-[#3ecf8e] transition-colors cursor-pointer inline-flex items-baseline gap-1 focus:outline-none border-b border-dashed border-[#555] hover:border-[#3ecf8e] ">
              {tool.label}
              <span className="text-[#888] text-xs">▾</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-[#111] border-[#333] font-mono">
              {TOOLS.map((t, i) => (
                <DropdownMenuItem
                  key={t.label}
                  onClick={() => setSelectedTool(i)}
                  className="text-[#ccc] text-sm cursor-pointer focus:bg-[#1a1a1a] focus:text-[#3ecf8e]"
                >
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>{' '}
          up-to-date docs via SSH:
        </p>

        {/* Setup commands */}
        <CodeBlock copyText={tool.command}>
          <span className="text-[#3ecf8e] select-none mr-1">$ </span>
          <span className="text-[#ccc]">{tool.command}</span>
        </CodeBlock>
        <p className="text-center font-mono text-xs text-white -my-1">OR</p>
        <CodeBlock copyText={appendCommand} variant="ghost">
          <span className="text-[#444] group-hover:text-[#3ecf8e] select-none mr-1 transition-colors">
            ${' '}
          </span>
          <span className="text-[#666] group-hover:text-[#ccc] transition-colors">
            {appendCommand}
          </span>
        </CodeBlock>
      </div>
    </div>
  )
}
