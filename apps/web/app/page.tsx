import { ChatWidgetLoader } from '@/components/chat-widget-loader'
import { SetupSnippet } from '@/components/setup-snippet'
import { Hero } from '../components/hero'

export default function Home() {
  return (
    <main className="h-screen bg-[#0a0a0a] font-mono flex flex-col">
      <Hero />

      {/* Setup section */}
      <section className="w-full text-center px-4">
        <h2 className="text-lg font-mono font-bold text-white mb-6">Setup</h2>
        <SetupSnippet />
      </section>

      <section className="px-4 pb-4 flex-1 flex flex-col min-h-0">
        <h2 className="text-lg font-mono font-bold text-white mb-6 text-center">Try it</h2>
        <div className="flex-1 min-h-0">
          <ChatWidgetLoader />
        </div>
      </section>
    </main>
  )
}
