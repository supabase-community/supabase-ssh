import { Box } from 'ink'
import type { ChatMessage } from './ui/chat'
import { ChatPanel } from './ui/chat'

interface ChatTerminalProps {
  messages: ChatMessage[]
  streamingText: string
  isLoading: boolean
  onSendMessage: (text: string) => void
}

/** Ink component that renders inside xterm.js. */
export function ChatTerminal({
  messages,
  streamingText,
  isLoading,
  onSendMessage,
}: ChatTerminalProps) {
  return (
    <Box flexDirection="column">
      <ChatPanel
        messages={messages}
        streamingText={streamingText}
        isLoading={isLoading}
        onSendMessage={onSendMessage}
      />
    </Box>
  )
}
