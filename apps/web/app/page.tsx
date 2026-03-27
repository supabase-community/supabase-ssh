import { ChatWidgetLoader } from '@/components/chat-widget-loader'
import { SetupSnippet } from '@/components/setup-snippet'
import { Hero } from '../components/hero'

export default function Home() {
  return (
    <main className="h-screen bg-[#0a0a0a] font-mono flex flex-col py-10 gap-15">
      <Hero />

      <section className="px-4 flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-0">
          <ChatWidgetLoader />
        </div>
      </section>

      <section className="w-full text-center px-4 pb-15">
        <SetupSnippet />
      </section>
    </main>
  )
}
