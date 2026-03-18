import { randomUUID } from 'node:crypto'
import { SpanKind, trace, diag, DiagConsoleLogger, DiagLogLevel, type Attributes, type Span } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

import pkg from '../package.json' with { type: 'json' }

const TRACER_NAME = pkg.name

let provider: BasicTracerProvider | null = null

/** Initialize OTel tracing. No-op if LOGFLARE_SOURCE/LOGFLARE_API_KEY are not set. */
export function initTelemetry(): void {
  const source = process.env.LOGFLARE_SOURCE
  const apiKey = process.env.LOGFLARE_API_KEY

  if (process.env.OTEL_LOG_LEVEL) {
    const level = DiagLogLevel[process.env.OTEL_LOG_LEVEL.toUpperCase() as keyof typeof DiagLogLevel]
    diag.setLogger(new DiagConsoleLogger(), level ?? DiagLogLevel.INFO)
  }

  if (!source || !apiKey) {
    console.log('[telemetry] disabled - LOGFLARE_SOURCE or LOGFLARE_API_KEY not set')
    return
  }

  const exporter = new OTLPTraceExporter({
    url: 'https://otel.logflare.app/v1/traces',
    headers: {
      'x-source': source,
      'x-api-key': apiKey,
    },
  })

  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: pkg.name,
      [ATTR_SERVICE_VERSION]: pkg.version,
      'deployment.environment': process.env.FLY_APP_NAME ?? 'local',
      'host.id': process.env.FLY_MACHINE_ID ?? 'unknown',
      'host.region': process.env.FLY_REGION ?? 'unknown',
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  })

  trace.setGlobalTracerProvider(provider)
  console.log('[telemetry] initialized - exporting to Logflare')
}

/** Flush pending spans and shut down. */
export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return
  try {
    await provider.shutdown()
  } catch (err) {
    console.error('[telemetry] shutdown error:', err)
  }
}

/** Session context built from ssh2 connection info + handshake. Denormalized onto every span. */
export interface SessionContext {
  sessionId: string
  mode: 'exec' | 'shell'
  hasPty: boolean
  clientSoftware: string
  clientProtocolVersion: string
  clientComments: string
  negotiatedKex: string
  negotiatedCipher: string
}

/** Create a new session context with a fresh session ID. */
export function createSessionContext(info: {
  header: {
    versions: { protocol: string; software: string }
    comments?: string
  }
}): SessionContext {
  return {
    sessionId: randomUUID(),
    mode: 'exec',
    hasPty: false,
    clientSoftware: info.header.versions.software ?? '',
    clientProtocolVersion: info.header.versions.protocol ?? '',
    clientComments: info.header.comments ?? '',
    negotiatedKex: '',
    negotiatedCipher: '',
  }
}

function sessionAttributes(ctx: SessionContext): Attributes {
  return {
    'ssh.session.id': ctx.sessionId,
    'ssh.session.mode': ctx.mode,
    'ssh.session.has_pty': ctx.hasPty,
    'ssh.client.software': ctx.clientSoftware,
    'ssh.client.protocol_version': ctx.clientProtocolVersion,
    'ssh.client.comments': ctx.clientComments,
    'ssh.negotiated.kex': ctx.negotiatedKex,
    'ssh.negotiated.cipher': ctx.negotiatedCipher,
  }
}

/** Start a command span before execution. Call endCommandSpan() when done. */
export function startCommandSpan(ctx: SessionContext, command: string): Span {
  const tracer = trace.getTracer(TRACER_NAME)
  return tracer.startSpan('ssh.command', {
    kind: SpanKind.SERVER,
    attributes: {
      ...sessionAttributes(ctx),
      'ssh.command.name': command.split(/\s+/)[0] ?? '',
      'ssh.command.text': command.slice(0, 1024),
    },
  })
}

/** End a command span with result attributes. */
export function endCommandSpan(
  span: Span,
  result: {
    exitCode: number
    stdoutBytes: number
    stderrBytes: number
    timedOut: boolean
  }
): void {
  span.setAttributes({
    'ssh.command.exit_code': result.exitCode,
    'ssh.command.stdout_bytes': result.stdoutBytes,
    'ssh.command.stderr_bytes': result.stderrBytes,
    'ssh.command.timed_out': result.timedOut,
  })
  span.end()
}

/** Record a rate-limited connection as a self-contained span. */
export function recordRateLimited(ctx: SessionContext, retryInSeconds: number): void {
  const tracer = trace.getTracer(TRACER_NAME)
  const span = tracer.startSpan('ssh.connection.rate_limited', {
    kind: SpanKind.SERVER,
    attributes: {
      ...sessionAttributes(ctx),
      'ssh.rate_limit.retry_in_seconds': retryInSeconds,
    },
  })
  span.end()
}

/** Record a rejected connection as a self-contained span. */
export function recordConnectionRejected(
  ctx: SessionContext,
  activeConnections: number,
  dropProbability: number
): void {
  const tracer = trace.getTracer(TRACER_NAME)
  const span = tracer.startSpan('ssh.connection.rejected', {
    kind: SpanKind.SERVER,
    attributes: {
      ...sessionAttributes(ctx),
      'ssh.server.active_connections': activeConnections,
      'ssh.server.drop_probability': dropProbability,
    },
  })
  span.end()
}
