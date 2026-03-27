'use client'

import type { UIMessage } from '@ai-sdk/react'
import { useChat } from '@ai-sdk/react'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { mountInk } from '../lib/ink-xterm'
import { ChatTerminal } from './chat-terminal'
import type { ChatMessage } from './ui/chat'

/** Below-fold chat widget. Uses mountInkInXterm directly for full control over sizing. */
export function ChatWidget() {
  const { messages, sendMessage, status } = useChat()
  const isLoading = status === 'streaming' || status === 'submitted'

  const { messages: chatMessages, streamingText: rawStreaming } = useMemo(
    () => transformMessages(messages),
    [messages],
  )

  // Debounce streaming text updates to 1s - xterm.js can't keep up with per-token rerenders
  const [renderedStreaming, setRenderedStreaming] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestStreamingRef = useRef(rawStreaming)
  latestStreamingRef.current = rawStreaming

  useEffect(() => {
    if (!rawStreaming) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setRenderedStreaming('')
      return
    }

    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setRenderedStreaming(latestStreamingRef.current)
      }, 1000)
    }
  }, [rawStreaming])

  const handleSend = useCallback((text: string) => sendMessage({ text }), [sendMessage])

  // Mount Ink into xterm.js directly
  const containerRef = useRef<HTMLDivElement>(null)
  const rerenderRef = useRef<((el: React.ReactElement) => void) | null>(null)
  const unmountRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el || mountedRef.current) return
    if (el.clientWidth === 0 || el.clientHeight === 0) return
    mountedRef.current = true
    let cancelled = false

    mountInk(
      <ChatTerminal messages={[]} streamingText="" isLoading={false} onSendMessage={handleSend} />,
      {
        container: el,
        focus: false,
        termOptions: {
          fontSize: 14,
          theme: { background: '#111111' },
        },
      },
    ).then(({ rerender, unmount }) => {
      if (cancelled) {
        unmount()
        return
      }
      rerenderRef.current = rerender
      unmountRef.current = unmount
    })

    return () => {
      cancelled = true
      mountedRef.current = false
      rerenderRef.current = null
      unmountRef.current?.()
    }
  }, [handleSend])

  // Re-render Ink when props change
  useEffect(() => {
    rerenderRef.current?.(
      <ChatTerminal
        messages={chatMessages}
        streamingText={renderedStreaming}
        isLoading={isLoading}
        onSendMessage={handleSend}
      />,
    )
  }, [chatMessages, renderedStreaming, isLoading, handleSend])

  return (
    <div className="w-full max-w-4xl min-w-xl mx-auto p-2 h-full">
      <div className="w-full h-full bg-[#111] border border-[#333] rounded-lg py-4 pl-4">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  )
}

/** Display name and which input field to show as the arg. */
const toolDisplay: Record<string, { name: string; argKey: string }> = {
  bash: { name: 'Bash', argKey: 'command' },
}

function formatToolTitle(toolName: string, input?: Record<string, unknown>): string {
  const display = toolDisplay[toolName]
  const name = display?.name ?? toolName
  const arg = display ? (input?.[display.argKey] as string) : undefined
  return arg ? `${name}(${arg})` : name
}

function transformMessages(messages: UIMessage[]): {
  messages: ChatMessage[]
  streamingText: string
} {
  const result: ChatMessage[] = []
  let streamingText = ''

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue

    const parts: ChatMessage['parts'] = []
    let textIdx = 0

    for (const part of msg.parts) {
      if (part.type === 'text') {
        if (part.state === 'streaming') {
          streamingText = part.text
        } else if (part.text) {
          parts.push({ type: 'text', id: `${msg.id}-t${textIdx++}`, text: part.text })
        }
      } else if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
        const toolPart = part as {
          toolCallId: string
          state: string
          input?: Record<string, unknown>
        } & ({ type: 'dynamic-tool'; toolName: string } | { type: string })
        const toolName =
          'toolName' in toolPart ? toolPart.toolName : toolPart.type.replace('tool-', '')
        parts.push({
          type: 'tool',
          id: toolPart.toolCallId,
          title: formatToolTitle(toolName, toolPart.input),
          status:
            toolPart.state === 'output-available'
              ? 'completed'
              : toolPart.state === 'output-error'
                ? 'failed'
                : 'in_progress',
        })
      }
    }

    if (parts.length > 0) {
      result.push({ id: msg.id, role: msg.role as 'user' | 'assistant', parts })
    }
  }

  return { messages: result, streamingText }
}
