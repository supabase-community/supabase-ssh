'use client'

import { type ReactNode, useState } from 'react'

interface CodeBlockProps {
  /** Text to copy to clipboard */
  copyText: string
  /** Content to display in the block */
  children: ReactNode
  /** Use "ghost" for a subdued, borderless style */
  variant?: 'default' | 'ghost'
}

/** Copyable code block with click-to-copy and feedback. */
export function CodeBlock({ copyText, children, variant = 'default' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`w-full rounded-lg px-5 py-4 pr-12 text-left font-mono text-xs sm:text-sm transition-colors cursor-pointer relative group ${
        variant === 'ghost'
          ? 'border border-[#333] hover:border-[#3ecf8e]'
          : 'bg-[#111] border border-[#333] hover:border-[#3ecf8e]'
      }`}
    >
      {children}
      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-[#888] group-hover:text-[#3ecf8e] transition-colors">
        {copied ? 'copied!' : 'copy'}
      </span>
    </button>
  )
}
