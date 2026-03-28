import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommandCache } from './command-cache.js'
import type { RateLimiter } from './ratelimit.js'
import { createApiServer } from './api.js'

const docsDir = mkdtempSync(join(tmpdir(), 'api-test-docs-'))

let app: ReturnType<typeof createApiServer>

beforeAll(() => {
  app = createApiServer({
    execTimeout: 5000,
    docsDir,
    allowedOrigin: 'https://example.com',
  })
})

afterAll(() => {})

// ---------------------------------------------------------------------------
// POST /api/exec
// ---------------------------------------------------------------------------
describe('POST /api/exec', () => {
  it('valid command returns stdout and exitCode 0', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hello' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stdout).toContain('hello')
    expect(body.exitCode).toBe(0)
  })

  it('failed command returns stderr and non-zero exitCode', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'exit 42' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.exitCode).toBe(42)
  })

  it('empty command returns 400', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('missing command field returns 400', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('command over 1000 chars returns 400', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'a'.repeat(1001) }),
    })
    expect(res.status).toBe(400)
  })

  it('non-string command returns 400', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 123 }),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
describe('CORS', () => {
  it('CORS headers present on POST response', async () => {
    const res = await app.request('/api/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
      },
      body: JSON.stringify({ command: 'echo cors' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
  })

  it('OPTIONS preflight returns 204', async () => {
    const res = await app.request('/api/exec', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    })
    expect(res.status).toBe(204)
  })
})

// ---------------------------------------------------------------------------
// Command cache
// ---------------------------------------------------------------------------
describe('command cache', () => {
  it('uses cache when provided', async () => {
    const cache = new CommandCache()
    const cwd = '/supabase'
    cache.set(cwd, 'echo cached', { stdout: 'from-cache\n', stderr: '', exitCode: 0 })

    const cachedApp = createApiServer({
      execTimeout: 5000,
      docsDir,
      commandCache: cache,
    })

    const res = await cachedApp.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo cached' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stdout).toBe('from-cache\n')
  })
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
describe('rate limiting', () => {
  it('returns 429 when rate limited', async () => {
    const rateLimiter: RateLimiter = {
      limit: async () => ({ success: false, reset: Date.now() + 30_000 }),
    }
    const rlApp = createApiServer({
      execTimeout: 5000,
      docsDir,
      rateLimiter,
    })

    const res = await rlApp.request('/api/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '1.2.3.4',
      },
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(res.status).toBe(429)
  })

  it('proceeds when rate limit passes', async () => {
    const rateLimiter: RateLimiter = {
      limit: async () => ({ success: true, reset: 0 }),
    }
    const rlApp = createApiServer({
      execTimeout: 5000,
      docsDir,
      rateLimiter,
    })

    const res = await rlApp.request('/api/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '1.2.3.4',
      },
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(res.status).toBe(200)
  })

  it('fails open when rate limiter throws', async () => {
    const rateLimiter: RateLimiter = {
      limit: async () => {
        throw new Error('Redis down')
      },
    }
    const rlApp = createApiServer({
      execTimeout: 5000,
      docsDir,
      rateLimiter,
    })

    const res = await rlApp.request('/api/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '1.2.3.4',
      },
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
describe('static file serving', () => {
  const webDir = mkdtempSync(join(tmpdir(), 'api-test-web-'))

  beforeAll(() => {
    writeFileSync(join(webDir, 'index.html'), '<html>home</html>')
    mkdirSync(join(webDir, '_next', 'static'), { recursive: true })
    writeFileSync(join(webDir, '_next', 'static', 'chunk-abc123.js'), 'console.log("hi")')
    writeFileSync(join(webDir, '404.html'), '<html>not found</html>')
  })

  it('serves index.html at root', async () => {
    const staticApp = createApiServer({ execTimeout: 5000, docsDir, webDir })
    const res = await staticApp.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('home')
  })

  it('serves hashed assets with immutable cache headers', async () => {
    const staticApp = createApiServer({ execTimeout: 5000, docsDir, webDir })
    const res = await staticApp.request('/_next/static/chunk-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('serves HTML with must-revalidate cache headers', async () => {
    const staticApp = createApiServer({ execTimeout: 5000, docsDir, webDir })
    const res = await staticApp.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('existing API routes still work with static serving enabled', async () => {
    const staticApp = createApiServer({ execTimeout: 5000, docsDir, webDir })
    const res = await staticApp.request('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hello' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stdout).toContain('hello')
  })

  it('healthz still works with static serving enabled', async () => {
    const staticApp = createApiServer({ execTimeout: 5000, docsDir, webDir })
    const res = await staticApp.request('/healthz')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('does not serve static files when webDir is not set', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(404)
  })
})
