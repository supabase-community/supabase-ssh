'use client'

import { useChat } from '@ai-sdk/react'
import { InkTerminalBox } from 'ink-web'
import 'ink-web/css'
import '@xterm/xterm/css/xterm.css'
import { ChatTerminal } from './chat-terminal'

/** Below-fold chat widget. Renders an xterm.js terminal with an AI chat panel inside. */
export function ChatWidget() {
  const { messages, sendMessage, status } = useChat()

  const isLoading = status === 'streaming' || status === 'submitted'

  // Transform AI SDK UIMessages into the shape ChatPanel expects
  const chatMessages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    toolCalls: Array<{
      id: string
      title: string
      status: 'pending' | 'in_progress' | 'completed' | 'failed'
      result?: string
    }>
  }> = []

  let streamingText = ''

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue

    const textParts: string[] = []
    const toolCalls: Array<{
      id: string
      title: string
      status: 'pending' | 'in_progress' | 'completed' | 'failed'
      result?: string
    }> = []

    for (const part of msg.parts) {
      if (part.type === 'text') {
        if (part.state === 'streaming') {
          streamingText = part.text
        } else {
          textParts.push(part.text)
        }
      } else if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
        const toolPart = part as {
          toolCallId: string
          state: string
          input?: { command?: string }
          output?: { stdout?: string }
        } & ({ type: 'dynamic-tool'; toolName: string } | { type: string })
        const toolName =
          'toolName' in toolPart ? toolPart.toolName : toolPart.type.replace('tool-', '')
        const command = toolPart.input?.command ?? toolName
        toolCalls.push({
          id: toolPart.toolCallId,
          title: `$ ${command}`,
          status:
            toolPart.state === 'output-available'
              ? 'completed'
              : toolPart.state === 'output-error'
                ? 'failed'
                : 'in_progress',
          result:
            toolPart.state === 'output-available'
              ? (toolPart.output?.stdout ?? undefined)
              : undefined,
        })
      }
    }

    const content = textParts.join('')
    if (content || toolCalls.length > 0) {
      chatMessages.push({
        id: msg.id,
        role: msg.role,
        content,
        toolCalls,
      })
    }
  }

  // Active tool calls are from the last assistant message if still streaming
  const lastMsg = chatMessages[chatMessages.length - 1]
  const activeToolCalls =
    isLoading && lastMsg?.role === 'assistant'
      ? lastMsg.toolCalls.filter((tc) => tc.status === 'in_progress')
      : []

  return (
    <div className="w-full max-w-255 mx-auto">
      <InkTerminalBox rows={20} focus={false} loading={false} padding={8}>
        <ChatTerminal
          messages={chatMessages}
          streamingText={streamingText}
          isLoading={isLoading}
          activeToolCalls={activeToolCalls}
          onSendMessage={(text) => {
            sendMessage({ text })
          }}
        />
      </InkTerminalBox>
    </div>
  )
}
