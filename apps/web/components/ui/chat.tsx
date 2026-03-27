import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

// --- ACP-aligned types ---

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCallInfo[]
}

export interface ToolCallInfo {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  result?: string
}

export interface ChatPanelProps {
  messages: ChatMessage[]
  streamingText?: string
  isLoading?: boolean
  activeToolCalls?: ToolCallInfo[]
  onSendMessage: (text: string) => void
  onCancel?: () => void
  placeholder?: string
  promptChar?: string
  promptColor?: string
  userColor?: string
  assistantColor?: string
  loadingText?: string
}

// --- Sub-components ---

function MessageBubble({
  message,
  userColor = 'green',
  assistantColor = 'blue',
}: {
  message: ChatMessage
  userColor?: string
  assistantColor?: string
}) {
  const isUser = message.role === 'user'

  return (
    <Box>
      <Text>
        <Text bold color={isUser ? userColor : assistantColor}>
          {isUser ? '> ' : '< '}
        </Text>
        <Text wrap="wrap">{message.content}</Text>
      </Text>
    </Box>
  )
}

function StreamingText({
  text,
  assistantColor = 'blue',
  cursorChar = '_',
}: {
  text: string
  assistantColor?: string
  cursorChar?: string
}) {
  if (!text) return null

  return (
    <Box>
      <Text>
        <Text bold color={assistantColor}>
          {'< '}
        </Text>
        <Text wrap="wrap">{text}</Text>
        <Text dimColor>{cursorChar}</Text>
      </Text>
    </Box>
  )
}

const TOOL_STATUS_ICONS: Record<ToolCallInfo['status'], string> = {
  pending: '\u2022',
  in_progress: '\u280B',
  completed: '\u2713',
  failed: '\u2717',
}

const TOOL_STATUS_COLORS: Record<ToolCallInfo['status'], string> = {
  pending: 'gray',
  in_progress: 'yellow',
  completed: 'green',
  failed: 'red',
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallInfo }) {
  const icon = TOOL_STATUS_ICONS[toolCall.status]
  const color = TOOL_STATUS_COLORS[toolCall.status]

  return (
    <Box paddingLeft={2}>
      <Text color={color}>
        {icon} {toolCall.title}
      </Text>
      {(toolCall.status === 'pending' || toolCall.status === 'in_progress') && (
        <Text dimColor> ...</Text>
      )}
    </Box>
  )
}

function ChatInput({
  onSubmit,
  placeholder = 'Type a message...',
  prompt = '> ',
  promptColor = 'green',
  disabled = false,
}: {
  onSubmit: (text: string) => void
  placeholder?: string
  prompt?: string
  promptColor?: string
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
    <Box>
      <Text color={promptColor}>{prompt}</Text>
      {value ? (
        <Text>
          {value}
          {!disabled && <Text inverse> </Text>}
        </Text>
      ) : (
        <>
          {!disabled && <Text inverse> </Text>}
          <Text dimColor>{placeholder}</Text>
        </>
      )}
    </Box>
  )
}

// --- Main component ---

export function ChatPanel({
  messages,
  streamingText = '',
  isLoading = false,
  activeToolCalls = [],
  onSendMessage,
  placeholder,
  promptChar,
  promptColor,
  userColor,
  assistantColor,
  loadingText = 'Thinking...',
}: ChatPanelProps) {
  const isInputDisabled = isLoading || !!streamingText

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {messages.map((message) => (
          <Box key={message.id}>
            <MessageBubble
              message={message}
              userColor={userColor}
              assistantColor={assistantColor}
            />
          </Box>
        ))}
      </Box>

      {activeToolCalls.length > 0 && (
        <Box flexDirection="column">
          {activeToolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </Box>
      )}

      {streamingText ? (
        <StreamingText text={streamingText} assistantColor={assistantColor} />
      ) : isLoading ? (
        <Box>
          <Text dimColor> {loadingText}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <ChatInput
          onSubmit={onSendMessage}
          disabled={isInputDisabled}
          placeholder={placeholder}
          prompt={promptChar}
          promptColor={promptColor}
        />
      </Box>
    </Box>
  )
}

export default ChatPanel
