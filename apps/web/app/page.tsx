import { Hero } from '../components/hero'

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] font-mono">
      <Hero />

      {/* Chat widget placeholder */}
      <div className="max-w-225 mx-auto px-4 pb-20" />
    </main>
  )
}
