import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { CommandCache } from './command-cache.js'
import type { RateLimiter } from './ratelimit.js'
import { createBash } from './shell/bash.js'

export interface ApiServerOptions {
  enableExec?: boolean
  execTimeout?: number
  commandCache?: CommandCache | null
  rateLimiter?: RateLimiter
  allowedOrigin?: string
  docsDir?: string
  webDir?: string
}

/** Creates a public-facing HTTP API server with CORS and /api/exec endpoint. */
export function createApiServer(opts: ApiServerOptions = {}) {
  const {
    enableExec = false,
    execTimeout = 10_000,
    commandCache = null,
    rateLimiter,
    allowedOrigin = '*',
    docsDir,
    webDir,
  } = opts

  const version = process.env.VERSION ?? 'dev'

  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    c.header('X-Version', version)
  })

  app.get('/healthz', (c) => c.json({ status: 'ok', version }))

  if (enableExec) {
    app.use(
      '/api/*',
      cors({
        origin: allowedOrigin,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      }),
    )

    app.post('/api/exec', async (c) => {
      // Rate limit by IP
      if (rateLimiter) {
        const ip =
          c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
          c.req.header('x-real-ip') ??
          'unknown'
        try {
          const { success, reset } = await rateLimiter.limit(ip)
          if (!success) {
            const retryIn = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
            return c.json({ error: `Too many requests. Retry in ${retryIn}s.` }, 429)
          }
        } catch {
          // Fail open - don't block requests when rate limiter is down
        }
      }

      // Parse and validate body
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body.' }, 400)
      }

      if (!body || typeof body !== 'object' || !('command' in body)) {
        return c.json({ error: 'Missing required field: command.' }, 400)
      }

      const { command } = body as { command: unknown }

      if (typeof command !== 'string') {
        return c.json({ error: 'command must be a string.' }, 400)
      }
      if (command.length === 0) {
        return c.json({ error: 'command must not be empty.' }, 400)
      }
      if (command.length > 1000) {
        return c.json({ error: 'command must be 1000 characters or fewer.' }, 400)
      }

      const cwd = '/supabase'

      // Check cache
      const cached = commandCache?.get(cwd, command)
      if (cached) {
        return c.json({
          stdout: cached.stdout ?? '',
          stderr: cached.stderr ?? '',
          exitCode: cached.exitCode,
        })
      }

      // Execute command
      try {
        const { bash } = await createBash(docsDir)
        const result = await bash.exec(command, { cwd, signal: AbortSignal.timeout(execTimeout) })
        commandCache?.set(cwd, command, result)
        return c.json({
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.exitCode,
        })
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError'
        if (timedOut) {
          return c.json({ error: 'Command timed out.' }, 504)
        }
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
      }
    })
  }

  if (webDir) {
    app.use('/_next/static/*', (c, next) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
      return next()
    })

    app.use('/_next/static/*', serveStatic({ root: webDir }))

    app.use('/*', (c, next) => {
      c.header('Cache-Control', 'public, max-age=0, must-revalidate')
      return next()
    })

    app.use('/*', serveStatic({ root: webDir }))

    app.notFound((c) => {
      return c.html('Not found', 404)
    })
  }

  return app
}
