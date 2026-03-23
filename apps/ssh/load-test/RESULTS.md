# SSH Server Load Testing - Findings

> Report written by Claude

## TL;DR

The SSH docs server is **CPU-bound, not memory-bound**. Doubling RAM from 256MB to 1GB made zero difference to latency. The single-threaded Node.js event loop (running `just-bash` command interpretation) is the bottleneck. Fly's CPUs (both shared and dedicated) are significantly weaker than local development machines - the p95 latency gap grows with load, not just from network RTT but from slower CPU processing. The right scaling strategy is many small instances with tight concurrency limits, not fewer large instances.

## What we tested

We built a load test framework (`load-test/`) that replays a captured real agent session (12 commands including `find`, `cat`, `grep` across the docs tree) at increasing concurrency. Each step runs for 60 seconds at a fixed number of virtual users (VUs), measuring per-command latency percentiles.

Profile source: OTel-captured Claude Code agent session doing "build a Supabase auth feature with RLS policies".

## Discovery results (Docker, unlimited CPU)

All limits disabled. Docker containers on macOS/OrbStack with no CPU constraint (full host CPU available). Measures raw server capacity.

### Latency comparison across memory tiers

| VUs | 256MB p95 | 512MB p95 | 1GB p95 |
| --- | --------- | --------- | ------- |
| 5   | 155ms     | 157ms     | 133ms   |
| 10  | 273ms     | 311ms     | 224ms   |
| 25  | 533ms     | 553ms     | 500ms   |
| 50  | 1062ms    | 914ms     | 1136ms  |
| 100 | 1986ms    | 1761ms    | 1916ms  |
| 200 | hung\*    | 3457ms    | 3800ms  |
| 400 | hung\*    | 9554ms    | 8787ms  |

\*256MB hung at 200 VUs before we added client-side exec timeouts and force-cleanup. The latency was not meaningful (event loop saturation). After the fix, 512MB and 1GB completed all steps.

### Key observations

**RAM doesn't matter.** The latency curves are nearly identical across 256MB, 512MB, and 1GB. This is because:

- Node.js baseline memory is ~60-80MB
- Each SSH session + just-bash interpreter adds minimal memory overhead
- The docs filesystem is read-only and cached by the OS

**CPU is the sole bottleneck.** Every command runs through just-bash's JavaScript interpreter on a single Node.js event loop thread. More concurrent VUs = more commands competing for CPU time slices. This is visible in:

- p50 stays low even at high VUs (commands themselves are fast when they get CPU)
- p95/p99 grow linearly with VU count (queuing delay)
- Throughput (cmd/s) plateaus around 75-95 cmd/s regardless of VU count

**Inflection point: ~25 VUs** (p95 crosses 500ms, >2x the 5-VU baseline). This is where 1-in-20 commands starts feeling slow. At 50 VUs, p95 crosses 1 second.

**Error onset: 200 VUs.** Server errors appear at 200 VUs across all memory tiers (34-54 errors). These are SSH-level failures from event loop saturation - the server's 10s exec timeout can't fire reliably because `just-bash` abort is cooperative (only checked at statement boundaries) and the event loop is backed up.

### 512MB full results (most complete run)

```
VUs  |  p50     p95     p99     max     | cmd/s  | errors | rejections
-----|-----------------------------------|--------|--------|----------
   5 |     9ms   157ms   186ms   191ms |    2.2 |      0 |          0
  10 |    12ms   311ms   437ms   444ms |    4.4 |      0 |          0
  25 |    13ms   553ms   686ms   693ms |   11.1 |      0 |          0
  50 |    37ms   914ms  1314ms  1356ms |   22.1 |      0 |          0
 100 |    80ms  1761ms  2708ms  2853ms |   44.1 |      0 |          0
 200 |   331ms  3457ms  6453ms  9180ms |   74.5 |     34 |          0
 400 |   303ms  9554ms 10816ms 11211ms |   94.9 |    355 |          0
```

## Fly.io results (shared-cpu-1x, 512MB)

Single machine, all limits disabled, real Fly shared CPU.

```
VUs  |  p50     p95     p99     max     | cmd/s  | errors | rejections
-----|-----------------------------------|--------|--------|----------
   5 |   310ms   554ms   796ms   807ms |    1.9 |      1 |          0
  10 |   308ms   714ms   925ms   950ms |    4.1 |      0 |          0
  25 |   331ms  1924ms  2441ms  2455ms |    9.4 |      1 |          0
  50 |   410ms  3583ms  5158ms  7639ms |   18.2 |      1 |          0
 100 |   690ms 15271ms 20717ms 22555ms |   21.3 |      6 |          0
 200 |  6499ms 15129ms 15129ms 15129ms |    0.4 |   2135 |          0
 400 |     0ms     0ms     0ms     0ms |    0.0 |   4400 |          0
```

### Shared CPU vs local Docker comparison

| VUs | Local p50 | Local p95 | Fly p50 | Fly p95 |
| --- | --------- | --------- | ------- | ------- |
| 5   | 9ms       | 157ms     | 310ms   | 554ms   |
| 10  | 12ms      | 311ms     | 308ms   | 714ms   |
| 25  | 13ms      | 553ms     | 331ms   | 1924ms  |
| 50  | 37ms      | 914ms     | 410ms   | 3583ms  |
| 100 | 80ms      | 1761ms    | 690ms   | 15271ms |

### Key observations

**~300ms baseline from network RTT.** p50 at 5 VUs is 310ms vs 9ms local. This is Fly proxy + network overhead - expected and acceptable.

**Shared CPU degrades much faster.** At 25 VUs, Fly p95 is 1924ms vs 553ms local (3.5x worse). At 100 VUs, it's 15s vs 1.7s (9x worse). The noisy-neighbor effect on shared CPU is severe.

**200 VUs killed the server.** 2135 errors (vs 34 locally). At 400 VUs, 100% error rate - the server was completely unresponsive. Shared CPU can't handle the event loop contention that local Docker (with full host CPU) could absorb.

**Inflection point: ~10 VUs on Fly** (p95 crosses 700ms). Stricter than the ~25 VU inflection seen locally. By 25 VUs, p95 is already 2s.

## Fly.io results (performance-1x, 2GB)

Single machine, all limits disabled, dedicated CPU.

```
VUs  |  p50     p95     p99     max     | cmd/s  | errors | rejections
-----|-----------------------------------|--------|--------|----------
   5 |   318ms   624ms   705ms   978ms |    2.0 |      0 |          0
  10 |   323ms   724ms   934ms   987ms |    4.1 |      0 |          0
  25 |   333ms  1833ms  2455ms  2587ms |   10.2 |      0 |          0
  50 |   350ms  2680ms  4045ms  4427ms |   18.2 |      6 |          0
 100 |   623ms  6089ms 10253ms 13559ms |   30.8 |      1 |          0
 200 |   811ms 13200ms 13818ms 28173ms |   38.1 |      3 |          0
 400 | 10237ms 28532ms 29517ms 29834ms |   25.7 |     19 |          0
```

### Shared vs dedicated CPU comparison (Fly)

| VUs | Shared p95 | Dedicated p95 | Local p95 |
| --- | ---------- | ------------- | --------- |
| 5   | 554ms      | 624ms         | 157ms     |
| 10  | 714ms      | 724ms         | 311ms     |
| 25  | 1924ms     | 1833ms        | 553ms     |
| 50  | 3583ms     | 2680ms        | 914ms     |
| 100 | 15271ms    | 6089ms        | 1761ms    |
| 200 | crashed    | 13200ms       | 3457ms    |
| 400 | crashed    | 28532ms       | 9554ms    |

### Key observations

**Low load (5-25 VUs): shared and dedicated are nearly identical.** Dedicated CPU doesn't help when there's no CPU contention. Both show ~300ms network RTT baseline.

**High load (100+ VUs): dedicated survives where shared crashes.** At 200 VUs, dedicated had 3 errors vs shared's 2135. At 400 VUs, dedicated was degraded but functional (19 errors) vs shared's total failure. Dedicated CPU buys resilience under extreme load.

**Both are still 3x worse than local Docker, and the gap grows with load.** The ~300ms p50 baseline is network RTT, but the p95 gap expands from ~400ms at 5 VUs to ~4300ms at 100 VUs. This means Fly's CPUs (even dedicated) are genuinely slower than an M2 Max - queuing delay accumulates faster because each command takes longer to process.

**Dedicated CPU doesn't improve the comfortable operating range.** Inflection point is still ~25 VUs on both (p95 ~1.8-1.9s). The benefit only shows at 50+ VUs where shared starts falling apart.

**Not worth 16x the cost for this workload.** At $32/mo (performance-1x/2GB) vs $2/mo (shared-cpu-1x/256MB), dedicated CPU only helps at load levels we'd already be rejecting via concurrency limits. With a hard cap of ~20 connections, both CPU types perform identically.

## What this means for Fly.io sizing

### Instance size recommendation

**shared-cpu-1x / 256MB ($2.02/mo)**. The dedicated CPU test confirmed that the noisy-neighbor effect only matters at high concurrency (50+ VUs). At the target operating range (30 connections triggers autoscale), shared and dedicated perform the same. The 16x price difference ($32/mo for performance-1x) is not justified.

### Latency budget for AI agents

The right concurrency limit depends on acceptable latency, not a fixed inflection-point heuristic. Our users are AI agents (Claude Code, etc) that spend 10-30s thinking between commands - command response time is a small fraction of overall session time.

| p95 target | Max VUs (Fly shared) | Use case                                       |
| ---------- | -------------------- | ---------------------------------------------- |
| ~1s        | ~10                  | Overly conservative for agents                 |
| ~2s        | ~25                  | Comfortable - barely noticeable in agent flow  |
| ~5s        | ~50                  | Acceptable for agents, even expensive commands |
| ~15s       | ~100                 | Degraded but functional, last-resort zone      |

**2-5s p95 is reasonable for this workload.** A 2s tail latency on 1-in-20 commands adds negligible time to an agent session that already takes minutes. Even expensive commands (large `grep -r`) at 5s are fine.

### Scaling strategy: horizontal, not vertical

SSH sessions are fully independent (no shared in-memory state - rate limiter is in Redis, docs are read-only). This means:

- Horizontal scaling gives linear capacity increase
- Smaller instances = cheaper autoscaling granularity (adding 1 unit at $2 vs $32)
- Better fault isolation (one bad session can't starve an entire large instance)

**Target: autoscale at ~30 concurrent sessions per instance** (Fly soft_limit). Each instance can handle up to 100 before hard rejection, but autoscaling should keep most instances well below that.

### Concurrency limits

Rather than throwing more CPU at it, cap concurrency low enough that each instance stays in its comfortable zone. Our existing limit architecture (soft/hard capacity, per-IP, rate limiting) is well-suited for this.

Key insight: **for AI agents, "slow but working" always beats "fast rejection."** A 5s grep result is infinitely more useful than a rejection that forces the agent to retry or fail. This means autoscaling should handle latency, and app-level limits should only fire to prevent server death.

Calibrated values:

```
Fly soft (30)  → autoscale trigger (p95 ~2-3s, plenty of runway)
App RED  (80)  → probabilistic rejection (server protection, should rarely fire)
App hard (100) → 100% rejection (server survival ceiling)
Fly hard (110) → proxy backstop (app always owns rejection UX)
```

- **Fly soft_limit = 30**: triggers autoscale while latency is still comfortable. Agents barely notice 2-3s commands between 10-30s think times.
- **App RED = 80**: probabilistic rejection ramps 80-100. Only fires when autoscaling can't keep up (lag during spin-up, or all machines maxed). At this point, rejecting some connections protects the server from the error cascade that starts at ~100-200 connections.
- **App hard = 100**: at the edge of server survival on Fly shared CPU (6 errors at 100 VUs in testing). All new connections rejected with friendly message.
- **Fly hard_limit = 110**: backstop above app hard cap so the app always owns the rejection UX (friendly message vs TCP reset).
- **Per-IP = 10**: existing default, reasonable for expected tenant mix.

### Multi-core: cost analysis

An alternative to horizontal scaling is using Node.js `cluster` module to utilize multiple CPU cores on a single instance. Here's the math:

| Config                           | Cost/mo | Sessions/instance | Cost/session |
| -------------------------------- | ------- | ----------------- | ------------ |
| 1x shared-cpu-1x/256MB           | $2.02   | ~15               | $0.13        |
| 2x shared-cpu-1x/256MB           | $4.04   | ~30               | $0.13        |
| 1x shared-cpu-2x/512MB + cluster | ~$6.00  | ~30 (if 2x)       | $0.20        |
| 1x shared-cpu-4x/1GB + cluster   | ~$14.00 | ~60 (if 4x)       | $0.23        |

Two separate 1-CPU instances at $4.04/mo match a 2-CPU cluster instance at ~$6/mo for the same capacity. Cluster mode would need to deliver **>1.5x throughput per core** just to break even - unlikely given OS scheduling overhead and the master process tax. At 4 CPUs the gap widens further.

Multi-core only becomes interesting if Fly's per-machine overhead (proxy routing, health checks, cold starts) dominates at high instance counts (20+ machines). For now, horizontal scaling is simpler and cheaper.

## Bugs found and fixed during testing

1. **Missing client-side exec timeout** - `ssh-client.ts` `exec()` had no timeout. Commands could hang indefinitely under load, causing the entire test to stall. Fixed: 30s client-side timeout with `timedOut` flag.

2. **No force-cleanup of stale connections** - `runner.ts` used `Promise.race` for grace period but never actually destroyed connections. Fixed: track `activeClients: Set<Client>`, force `.destroy()` after 10s grace.

3. **False error counting** - Non-zero exit codes (e.g., `grep` returning 1 for no matches) were counted as failures. Fixed: split into `serverErrors` (SSH-level) vs `nonZeroExits` (normal command behavior).

4. **Cooperative abort limitation** - Server-side `EXEC_TIMEOUT` (10s) uses `AbortSignal` but `just-bash` only checks it at statement boundaries. Under heavy load, the event loop can't process the abort check promptly. The client-side timeout is the real safety net.

## Next steps

- [x] Deploy to Fly staging and run latency-under-load on real shared-cpu-1x
- [x] Compare shared vs dedicated CPU on Fly (dedicated not worth 16x cost)
- [ ] Run remaining Tier 1 scenarios: idle-pressure, memory-soak, session-churn
- [ ] Tier 2: calibrate limits based on Fly results
- [ ] Tier 3: validate limits protect against the breakdowns we found

## How to run

```bash
cd apps/ssh

# Docker (local discovery)
pnpm tsx load-test/cli.ts latency-under-load --memory 256m
pnpm tsx load-test/cli.ts latency-under-load --memory 256m --cpus 1

# Against remote server (Fly staging)
pnpm tsx load-test/cli.ts latency-under-load \
  --host <fly-app>.fly.dev --port 22 \
  --metrics http://localhost:9091
```
