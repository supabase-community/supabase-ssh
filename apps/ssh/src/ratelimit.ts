import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

/** Checks whether a connection from the given IP should be allowed. */
export interface RateLimiter {
  limit(ip: string): Promise<{ success: boolean; reset: number }>
}

export interface RateLimiterConfig {
  url: string
  token: string
  maxRequests?: number
  windowSeconds?: number
}

/** Creates a Redis-backed sliding window rate limiter. */
export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const redis = new Redis({
    url: config.url,
    token: config.token,
  })

  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(
      config.maxRequests ?? 30,
      `${config.windowSeconds ?? 60} s`
    ),
    prefix: 'ssh:ratelimit',
  })

  return ratelimit
}
