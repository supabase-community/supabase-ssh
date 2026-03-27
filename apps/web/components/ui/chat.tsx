import { TextInput } from '@inkjs/ui'
import { Box, Text } from 'ink'
import { useCallback, useState } from 'react'

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
  const border = '##212121'
  const green = '#3ecf8e'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border}>
      <Box flexDirection="row">
        <Box
          flexDirection="column"
          marginY={1}
          marginX={4}
          flexShrink={0}
          flexGrow={0}
          justifyContent="center"
        >
          <Text color={green}>{' ┌────┐'}</Text>
          <Text color={green}>{' │    │'}</Text>
          <Text color={green}>{' │    │'}</Text>
          <Text color={green}>{'┌─┐  ┌─┐'}</Text>
          <Text color={green}>{'└─┘  └─┘'}</Text>
          <Text color={green}>{' │    │'}</Text>
          <Text color={green}>{' │ │  │ │'}</Text>
          <Text color={green}>{' │ │  │ │'}</Text>
          <Text color={green}>{' │ └──┘ │'}</Text>
          <Text color={green}>{' │      │'}</Text>
          <Text color={green}>{' └──────┘'}</Text>
        </Box>
        <Box
          flexDirection="column"
          flexShrink={1}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={border}
          paddingTop={1}
          gap={1}
        >
          <Box flexDirection="column" paddingX={2}>
            <Box flexDirection="column" gap={1}>
              <Text color="white" wrap="wrap">
                <Text color={green}>supabase.sh</Text> exposes Supabase docs over SSH:
              </Text>
              <Box padding={1} backgroundColor="#212121" flexGrow={0}>
                <Text color="white" wrap="wrap">
                  <Text color={green}>$</Text> ssh supabase.sh{' '}
                  <Text color="#777777">{'<grep/find/cat/etc>'}</Text>
                </Text>
              </Box>
              <Text color="white" wrap="wrap">
                Try it yourself in a real terminal!
              </Text>
            </Box>
          </Box>
          <Box
            flexDirection="column"
            paddingX={2}
            borderStyle="single"
            borderLeft={false}
            borderTop
            borderRight={false}
            borderBottom={false}
            borderColor={border}
            paddingY={1}
          >
            <Text color="white" wrap="wrap">
              Combine it with your favorite AI agent to give it up-to-date docs from Supabase as you
              develop your app.
            </Text>
          </Box>
        </Box>
      </Box>
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
  const [inputKey, setInputKey] = useState(0)

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (trimmed) {
        onSubmit(trimmed)
        setInputKey((k) => k + 1)
      }
    },
    [onSubmit],
  )

  return (
    <Box
      width="100%"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
    >
      <Text color="#3ecf8e">❯ </Text>
      <TextInput
        key={inputKey}
        isDisabled={disabled}
        onSubmit={handleSubmit}
        placeholder="Ask Clippy about Supabase..."
      />
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
    <Box flexDirection="column" gap={1}>
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
