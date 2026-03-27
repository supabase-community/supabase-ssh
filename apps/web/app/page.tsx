import { ChatWidgetLoader } from '../components/chat-widget-loader'
import { Hero } from '../components/hero'

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] font-mono">
      <Hero />

      <section className="px-4 pb-20">
        <h2 className="text-lg font-mono font-bold text-white mb-6 text-center">Try it</h2>
        <ChatWidgetLoader />
      </section>
    </main>
  )
}
