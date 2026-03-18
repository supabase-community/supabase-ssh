# Grafana Dashboards

## Available Metrics

**Gauges:** `ssh_active_connections` + prom-client defaults (`process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_external_memory_bytes`, nodejs GC, event loop lag, etc.)

**Counters:** `ssh_sessions_total{mode}`, `ssh_connection_rejections_total`, `ssh_commands_total{command, exit_code}`, `ssh_command_errors_total`, `ssh_command_timeouts_total`

**Histograms:** `ssh_command_duration_seconds`, `ssh_session_duration_seconds{mode, end_reason}`

## 1. Overview / Golden Signals

The "at a glance" board - oncall dashboard.

- Active connections gauge (current value + sparkline)
- Connection rate (`rate(ssh_sessions_total)`) by mode (exec vs shell)
- Rejection rate (`rate(ssh_connection_rejections_total)`) - capacity alarm
- Command error rate (`rate(ssh_command_errors_total) / rate(ssh_commands_total)`)
- Command timeout rate - same pattern
- p50/p95/p99 command latency from the histogram

## 2. Capacity & Resource Health

Helps decide when to scale or if we're leaking memory.

- Active connections vs soft/hard limit (overlay horizontal threshold lines at 80/100)
- RSS / heap used / external memory over time - watch for leaks across deploys
- Node.js event loop lag (from default metrics) - spikes mean overload
- GC pause duration (from default metrics)
- Rejections as % of total connections - if this climbs, need more capacity

## 3. Command Analytics

Understand what people are actually doing.

- Top commands table (`topk` on `ssh_commands_total` by `command` label) - cat, grep, tree, agents, etc.
- Command duration heatmap - spot slow commands visually
- Error rate by command - which commands fail most?
- Timeouts over time - are people hitting the 10s exec limit?
- Exec vs shell split - ratio of one-shot vs interactive

## 4. Session Behavior

Understand how people use the service.

- Session duration distribution by mode - how long do shell sessions last?
- Session end reason breakdown (pie or stacked bar: `user_exit` vs `idle_timeout` vs `max_timeout` vs `server_shutdown`)
- If idle_timeout dominates, the 60s timeout might be too aggressive
- If max_timeout is common, people want longer sessions

## Priority

1. **Overview** - daily dashboard, alert on this
2. **Command Analytics** - tells us what content people actually want
3. **Session Behavior** and **Capacity** - second-pass once we have traffic

## Gaps

- **Bytes served** - not currently tracked in Prometheus. Adding a counter for total bytes out would let us track bandwidth and spot abuse.
- **Client fingerprinting** - client software, kex/cipher info is only in OTel spans. Could add Prometheus labels or counters if we want this on dashboards.
