import { Hono } from 'hono'

import { getActiveConnectionCount, getRegistry } from './metrics.js'

export const app = new Hono()

app.get('/metrics', async (c) => {
  const registry = getRegistry()
  const metrics = await registry.metrics()
  return c.text(metrics, 200, { 'Content-Type': registry.contentType })
})

app.get('/healthz', (c) => {
  return c.json({
    status: 'ok',
    activeConnections: getActiveConnectionCount(),
    uptimeSeconds: Math.floor(process.uptime()),
  })
})
