import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

// --- Types ---

export interface TextPart {
  type: 'text'
  id: string
  text: string
}

export interface ToolCallPart {
  type: 'tool'
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export type MessagePart = TextPart | ToolCallPart

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
}

export interface ChatPanelProps {
  messages: ChatMessage[]
  streamingText?: string
  isLoading?: boolean
  onSendMessage: (text: string) => void
}

// --- Sub-components ---

function Header() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#3ecf8e" paddingX={1}>
      <Text bold color="#3ecf8e">
        supabase.sh
      </Text>
      <Text dimColor>Browse Supabase docs with bash.</Text>
      <Text dimColor>
        Model: <Text color="white">gpt-5.4-nano</Text>
      </Text>
    </Box>
  )
}

function UserMessage({ text }: { text: string }) {
  return (
    <Box width="100%">
      <Box backgroundColor="#1a1a2e" width="100%" paddingRight={1}>
        <Text color="white" wrap="wrap">
          <Text color="#3ecf8e">❯ </Text>
          {text}
        </Text>
      </Box>
    </Box>
  )
}

function AssistantText({ text }: { text: string }) {
  return (
    <Box flexDirection="row">
      <Text color="#3ecf8e">⏺ </Text>
      <Box flexShrink={1}>
        <Text wrap="wrap" color="white">
          {text}
        </Text>
      </Box>
    </Box>
  )
}

function ToolCallCard({ title }: { title: string }) {
  return (
    <Box>
      <Text color="#3ecf8e">⏺ </Text>
      <Text dimColor>{title}</Text>
    </Box>
  )
}

function ChatInput({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (text: string) => void
  disabled?: boolean
}) {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      const trimmed = value.trim()
      if (trimmed) {
        onSubmit(trimmed)
        setValue('')
      }
      return
    }

    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1))
      return
    }

    if (!key.ctrl && !key.meta && input) {
      setValue((prev) => prev + input)
    }
  })

  return (
    <Box
      width="100%"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
    >
      <Text color="#3ecf8e">❯ </Text>
      <Text color="white">
        {value}
        {!disabled && <Text inverse> </Text>}
      </Text>
    </Box>
  )
}

// --- Main component ---

export function ChatPanel({
  messages,
  streamingText = '',
  isLoading = false,
  onSendMessage,
}: ChatPanelProps) {
  const isInputDisabled = isLoading || !!streamingText

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header />

      {messages.map((msg) => (
        <Box key={msg.id} flexDirection="column" gap={1}>
          {msg.role === 'user' ? (
            <UserMessage text={msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')} />
          ) : (
            msg.parts.map((part) =>
              part.type === 'text' ? (
                <AssistantText key={part.id} text={part.text} />
              ) : (
                <ToolCallCard key={part.id} title={part.title} />
              ),
            )
          )}
        </Box>
      ))}

      {streamingText && (
        <Box flexDirection="row">
          <Text color="#3ecf8e">⏺ </Text>
          <Box flexShrink={1}>
            <Text wrap="wrap" color="white">
              {streamingText}
            </Text>
          </Box>
        </Box>
      )}

      {isLoading && !streamingText && (
        <Box>
          <Text dimColor> Thinking...</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <ChatInput onSubmit={onSendMessage} disabled={isInputDisabled} />
      </Box>
    </Box>
  )
}

export default ChatPanel
