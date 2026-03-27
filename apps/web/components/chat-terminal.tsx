import { Box } from 'ink'
import type { ChatMessage, ToolCallInfo } from './ui/chat'
import { ChatPanel } from './ui/chat'

interface ChatTerminalProps {
  messages: ChatMessage[]
  streamingText: string
  isLoading: boolean
  activeToolCalls: ToolCallInfo[]
  onSendMessage: (text: string) => void
}

/** Ink component that renders inside xterm.js via ink-web. */
export function ChatTerminal({
  messages,
  streamingText,
  isLoading,
  activeToolCalls,
  onSendMessage,
}: ChatTerminalProps) {
  return (
    <Box flexDirection="column">
      <ChatPanel
        messages={messages}
        streamingText={streamingText}
        isLoading={isLoading}
        activeToolCalls={activeToolCalls}
        onSendMessage={onSendMessage}
        promptColor="green"
        userColor="green"
        assistantColor="white"
      />
    </Box>
  )
}
