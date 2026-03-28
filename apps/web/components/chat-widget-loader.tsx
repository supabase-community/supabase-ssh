'use client'

import { useEffect, useState } from 'react'

export function ChatWidgetLoader() {
  const [Widget, setWidget] = useState<React.ComponentType | null>(null)

  // Dynamic import avoids SSR (ink/xterm need DOM) and code-splits the bundle
  useEffect(() => {
    import('./chat-widget').then((m) => setWidget(() => m.ChatWidget))
  }, [])

  if (!Widget) return <div className="h-full" />

  return (
    <div className="h-full">
      <Widget />
    </div>
  )
}
