import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { trace } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { truncateIP, createSessionContext, startCommandSpan, endCommandSpan, recordConnectionRejected } from './telemetry.js'

// -- truncateIP --

describe('truncateIP', () => {
  it('truncates IPv4 to /24', () => {
    expect(truncateIP('1.2.3.4')).toBe('1.2.3.0')
    expect(truncateIP('192.168.1.255')).toBe('192.168.1.0')
    expect(truncateIP('10.0.0.1')).toBe('10.0.0.0')
  })

  it('truncates loopback', () => {
    expect(truncateIP('127.0.0.1')).toBe('127.0.0.0')
  })

  it('truncates IPv4-mapped IPv6', () => {
    expect(truncateIP('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.0')
    expect(truncateIP('::ffff:192.168.1.100')).toBe('::ffff:192.168.1.0')
  })

  it('truncates IPv6 to /48', () => {
    expect(truncateIP('2001:db8:85a3:1234:5678:8a2e:0370:7334')).toBe('2001:0db8:85a3::')
    expect(truncateIP('fe80:0000:0000:0000:1234:5678:abcd:ef01')).toBe('fe80:0000:0000::')
  })

  it('truncates abbreviated IPv6', () => {
    expect(truncateIP('2001:db8::1')).toBe('2001:0db8:0000::')
    expect(truncateIP('::1')).toBe('0000:0000:0000::')
  })
})

// -- createSessionContext --

describe('createSessionContext', () => {
  it('creates context with session ID and client info', () => {
    const ctx = createSessionContext({
      ip: '1.2.3.4',
      header: {
        versions: { protocol: '2.0', software: 'OpenSSH_9.6' },
        comments: 'Ubuntu',
      },
    })

    expect(ctx.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ctx.subnet).toBe('1.2.3.0')
    expect(ctx.clientSoftware).toBe('OpenSSH_9.6')
    expect(ctx.clientProtocolVersion).toBe('2.0')
    expect(ctx.clientComments).toBe('Ubuntu')
    expect(ctx.mode).toBe('exec')
    expect(ctx.hasPty).toBe(false)
    expect(ctx.negotiatedKex).toBe('')
    expect(ctx.negotiatedCipher).toBe('')
  })

  it('generates unique session IDs', () => {
    const a = createSessionContext({ ip: '1.2.3.4', header: { versions: { protocol: '2.0', software: '' } } })
    const b = createSessionContext({ ip: '1.2.3.4', header: { versions: { protocol: '2.0', software: '' } } })
    expect(a.sessionId).not.toBe(b.sessionId)
  })
})

// -- span recording with InMemorySpanExporter --

describe('span recording', () => {
  const exporter = new InMemorySpanExporter()
  let provider: BasicTracerProvider

  beforeAll(() => {
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
  })

  afterAll(async () => {
    await provider.shutdown()
  })

  it('startCommandSpan + endCommandSpan creates a span with session + command attributes', () => {
    exporter.reset()

    const ctx = createSessionContext({
      ip: '10.0.1.42',
      header: {
        versions: { protocol: '2.0', software: 'paramiko_3.4.0' },
        comments: '',
      },
    })
    ctx.mode = 'exec'
    ctx.hasPty = false
    ctx.negotiatedKex = 'curve25519-sha256'
    ctx.negotiatedCipher = 'aes128-gcm'

    const span = startCommandSpan(ctx, 'grep -r "auth" /supabase/docs')
    endCommandSpan(span, {
      exitCode: 0,
      stdoutBytes: 512,
      stderrBytes: 0,
      timedOut: false,
    })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)

    const finished = spans[0]
    expect(finished.name).toBe('ssh.command')

    const attrs = finished.attributes
    // Session context (denormalized)
    expect(attrs['ssh.session.id']).toBe(ctx.sessionId)
    expect(attrs['ssh.session.mode']).toBe('exec')
    expect(attrs['ssh.session.has_pty']).toBe(false)
    expect(attrs['ssh.client.software']).toBe('paramiko_3.4.0')
    expect(attrs['ssh.client.protocol_version']).toBe('2.0')
    expect(attrs['ssh.client.subnet']).toBe('10.0.1.0')
    expect(attrs['ssh.negotiated.kex']).toBe('curve25519-sha256')
    expect(attrs['ssh.negotiated.cipher']).toBe('aes128-gcm')

    // Command-specific
    expect(attrs['ssh.command.name']).toBe('grep')
    expect(attrs['ssh.command.text']).toBe('grep -r "auth" /supabase/docs')
    expect(attrs['ssh.command.exit_code']).toBe(0)
    expect(attrs['ssh.command.stdout_bytes']).toBe(512)
    expect(attrs['ssh.command.stderr_bytes']).toBe(0)
    expect(attrs['ssh.command.timed_out']).toBe(false)
  })

  it('startCommandSpan truncates command text to 1024 chars', () => {
    exporter.reset()

    const ctx = createSessionContext({
      ip: '1.2.3.4',
      header: { versions: { protocol: '2.0', software: '' } },
    })

    const longCommand = 'x'.repeat(2000)
    const span = startCommandSpan(ctx, longCommand)
    endCommandSpan(span, {
      exitCode: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
    })

    const spans = exporter.getFinishedSpans()
    const text = spans[0].attributes['ssh.command.text'] as string
    expect(text).toHaveLength(1024)
  })

  it('recordConnectionRejected creates a span', () => {
    exporter.reset()

    recordConnectionRejected('10.0.1.0', 'OpenSSH_9.6', 101)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('ssh.connection.rejected')
    expect(spans[0].attributes['ssh.client.subnet']).toBe('10.0.1.0')
    expect(spans[0].attributes['ssh.client.software']).toBe('OpenSSH_9.6')
    expect(spans[0].attributes['ssh.server.active_connections']).toBe(101)
  })
})
