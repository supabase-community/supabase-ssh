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

export const metadata: Metadata = {
  title: 'Supabase SSH',
  description: 'Browse Supabase docs over SSH.',
  openGraph: {
    title: 'Supabase SSH',
    description: 'Browse Supabase docs over SSH.',
    siteName: 'Supabase SSH',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Supabase SSH',
    description: 'Browse Supabase docs over SSH.',
    creator: '@supabase',
    site: '@supabase',
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
