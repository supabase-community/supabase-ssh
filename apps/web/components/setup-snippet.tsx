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
  { label: 'Claude Code', command: 'ssh supabase.sh setup | claude' },
  { label: 'Codex', command: 'codex "$(ssh supabase.sh setup)"' },
  { label: 'Cursor', command: 'agent "$(ssh supabase.sh setup)"' },
  { label: 'OpenCode', command: 'opencode --prompt "$(ssh supabase.sh setup)"' },
  { label: 'Gemini', command: 'gemini "$(ssh supabase.sh setup)"' },
  { label: 'Copilot', command: 'copilot -i "$(ssh supabase.sh setup)"' },
] as const

const APPEND_COMMAND = 'ssh supabase.sh agents >> AGENTS.md'

/** Dropdown + copyable command block for agent setup snippet. */
export function SetupSnippet() {
  const [selectedTool, setSelectedTool] = useState(0)
  const [copiedFootnote, setCopiedFootnote] = useState(false)

  const currentCommand = TOOLS[selectedTool]?.command ?? TOOLS[0].command

  async function copyFootnote() {
    await navigator.clipboard.writeText(APPEND_COMMAND)
    setCopiedFootnote(true)
    setTimeout(() => setCopiedFootnote(false), 2000)
  }

  return (
    <div className="w-full max-w-xl mx-auto">
      {/* Inline dropdown description */}
      <div className="mb-4 font-mono text-sm text-center">
        <p className="text-[#888]">
          Teach{' '}
          <DropdownMenu>
            <DropdownMenuTrigger className="text-white hover:text-[#3ecf8e] transition-colors cursor-pointer inline-flex items-baseline gap-1 focus:outline-none border-b border-dashed border-[#555] hover:border-[#3ecf8e]">
              {TOOLS[selectedTool].label}
              <span className="text-[#888] text-xs">▾</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-[#111] border-[#333] font-mono">
              {TOOLS.map((tool, i) => (
                <DropdownMenuItem
                  key={tool.label}
                  onClick={() => setSelectedTool(i)}
                  className="text-[#ccc] text-sm cursor-pointer focus:bg-[#1a1a1a] focus:text-[#3ecf8e]"
                >
                  {tool.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>{' '}
          how to use <code className="text-[#ccc]">ssh supabase.sh &lt;command&gt;</code>:
        </p>
      </div>

      {/* Command block */}
      <CodeBlock copyText={currentCommand}>
        <span className="text-[#3ecf8e] select-none mr-1">$ </span>
        <span className="text-[#ccc]">{currentCommand}</span>
      </CodeBlock>

      {/* Footnote */}
      <div className="mt-3 text-xs">
        <p className="text-[#888]">
          Or append directly:{' '}
          <button
            type="button"
            onClick={copyFootnote}
            className="font-mono text-[#ccc] hover:text-[#3ecf8e] transition-colors cursor-pointer"
            aria-label="Copy append command to clipboard"
          >
            <code>{APPEND_COMMAND}</code>
          </button>
        </p>
        <p
          className={`text-[#3ecf8e] mt-1 transition-opacity ${copiedFootnote ? 'opacity-100' : 'opacity-0'}`}
        >
          copied!
        </p>
      </div>
    </div>
  )
}
