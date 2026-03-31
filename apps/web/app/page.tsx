import { SetupSnippet } from '@/components/setup-snippet'
import { Hero } from '../components/hero'

export default function Home() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] font-mono flex flex-col py-10 gap-10">
      <Hero />

      <hr className="border-[#222] mx-auto w-full max-w-lg" />

      <section className="px-5">
        <SetupSnippet />
      </section>

      <footer className="mt-auto pt-10 pb-4 text-center font-mono text-xs text-[#555]">
        &copy;{' '}
        <a
          href="https://supabase.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#888] hover:text-[#3ecf8e] transition-colors"
        >
          Supabase
        </a>{' '}
        {new Date().getFullYear()} |{' '}
        <a
          href="https://github.com/supabase-community/supabase-ssh"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#888] hover:text-[#3ecf8e] transition-colors"
        >
          GitHub
        </a>
      </footer>
    </main>
  )
}
