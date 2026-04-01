import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

const OG_IMAGE = 'https://zhfonblqamxferhoguzj.supabase.co/functions/v1/generate-og?template=announcement&layout=vertical&copy=supabase.sh&icon=icon-CLI.svg'

export const metadata: Metadata = {
  title: 'Supabase SSH',
  description: 'Browse Supabase docs over SSH.',
  openGraph: {
    title: 'Supabase SSH',
    description: 'Browse Supabase docs over SSH.',
    siteName: 'Supabase SSH',
    type: 'website',
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: 'supabase.sh' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Supabase SSH',
    description: 'Browse Supabase docs over SSH.',
    creator: '@supabase',
    site: '@supabase',
    images: [OG_IMAGE],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#0a0a0a]">{children}</body>
    </html>
  )
}
