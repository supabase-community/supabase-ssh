import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  turbopack: {
    resolveAlias: {
      ink: 'ink-web',
      // Node-only (tty, process.env) - we handle links via xterm WebLinksAddon
      'supports-hyperlinks': './lib/shims/supports-hyperlinks.js',
    },
  },
}

export default nextConfig
