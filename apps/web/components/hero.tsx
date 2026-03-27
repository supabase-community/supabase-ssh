import { SetupSnippet } from './setup-snippet'

/** Hero section for the supabase.sh landing page. */
export function Hero() {
  return (
    <div className="flex flex-col items-center px-4 py-20">
      {/* Title + tagline */}
      <section className="text-center mb-10">
        <h1 className="text-4xl font-mono font-bold mb-4 flex items-baseline justify-center gap-4">
          <span className="text-[#888]">$</span>
          <span className="text-white">ssh</span>
          <span className="text-[#3ecf8e]">supabase.sh</span>
        </h1>
        <p className="text-[#888] font-mono text-sm">
          Browse{' '}
          <a
            href="https://supabase.com/docs"
            className="text-[#ccc] hover:text-[#3ecf8e] transition-colors underline underline-offset-2 decoration-[#555] hover:decoration-[#3ecf8e]"
          >
            Supabase docs
          </a>{' '}
          using bash. Designed for agents.
        </p>
      </section>

      {/* Setup section */}
      <section className="w-full text-center">
        <h2 className="text-lg font-mono font-bold text-white mb-6">Setup</h2>
        <SetupSnippet />
      </section>
    </div>
  )
}
