# RLog 3.1.0 release validation (development branch)

Date: 2026-10-27. Branch: feat/rlog-3.1. This is a local development
checkpoint, not an npm release and not a claim of CI success.

## Build and compatibility

- Windows ASUS: Node 24.8.0. Built from E:\RLog with TypeScript, and ran
  repository regressions, packaging checks, and crash tests.
- Linux Debian VPS: Node 24.22.0, one assigned CPU, approximately 488 MiB RAM
  and no swap. Tested the packaged 3.1.0 artifact, copied directly from
  Windows, not a published npm version. Creating nested Node child processes
  frequently fails with EAGAIN or a native pthread_create assertion here.
- Supported Node engines remain >=20. GitHub Actions has been configured for
  Node 20, 22 and 24 on Ubuntu, Windows and macOS. These CI jobs still require
  a future push/PR and have not been run for this checkpoint.

## Fault injection and runtime checks

| Test | Platform | Result | Scope |
| --- | --- | --- | --- |
| Three independent writers with instance-separated rotation | Windows | Pass, 108/108 records | Actual child processes |
| Three independently rotating logger instances | Linux VPS | Pass, 144/144 records | Single OS process only |
| File path invalid then repaired | Windows and Linux VPS | Pass | Retry after cooldown, no replay |
| ENOSPC using /dev/full | Linux VPS | Pass | I/O failure observable without filling disk |
| Repeated DEBUG with bounded queue | Linux VPS | Pass | 12 accepted, 1188 intentionally dropped |
| Processor, Transport, Flight Recorder | Linux VPS | Pass | Small smoke test |
| Injected fsync EIO | Windows | Pass | Sink disabled, error reported |
| Processor expansion beyond byte budget | Windows | Pass | Oversized output rejected before delivery |
| External forced termination after syncFiles | Windows | Pass, 30/30 records | Already-synchronized records survived |

The Windows suite includes a portable subprocess checkpoint test. The Linux
/dev/full fault test is conditionally enabled on Linux in the test suite.

### Limitations

- Linux VPS multi-process and SIGKILL-after-sync are not validated. Its nested
  Node process creation fails intermittently. Run those tests on GitHub-hosted
  Linux runners before a public release.
- Per-logger queues are not cross-process file locks. To avoid simultaneous
  rotation collisions, use instance isolation or a dedicated single writer.
- fsync cannot promise absolute durability through every hardware failure.
- The library deliberately does not replay uncertain previous writes.
- Tests were bounded; a multi-day memory or file-endurance soak test is pending.

## Windows JSONL throughput measurements

ASUS Node 24.8.0, five rounds per configuration, 2500 event records per round.
Median is calculated from enqueue-through-close time. This is a short, warmed
filesystem/cache-dependent benchmark, not a production latency guarantee.

| Configuration | Median records/sec | Min to max records/sec |
| --- | ---: | ---: |
| RLog 3.0 default | 37,183 | 26,299 to 38,117 |
| RLog 3.1 default | 37,210 | 30,907 to 38,733 |
| RLog 3.1 byte budgets | 24,047 | 21,999 to 24,376 |
| RLog 3.1 Processor | 24,737 | 21,922 to 27,232 |
| RLog 3.1 Flight Recorder (captures INFO) | 32,519 | 28,825 to 34,328 |

Reproduction: bench/release-3.1.cjs. Optionally set environment variable
RLOG_BENCH_BASELINE to an installed 3.0 entry path. The standalone script
otherwise benchmarks 3.1 only. It checks record counts and does not impose
brittle throughput gates on CI.

## Release checklist

1. Push and verify the entire GitHub Actions matrix (3 OS x 3 Node versions).
2. Verify Linux multi-process rotation and SIGKILL-after-sync on a runner not
   affected by the limited VPS environment.
3. Inspect TypeScript declarations, package exports, pack contents, changelog,
   default behavior, and semver compatibility.
4. Run a longer bounded soak test with slow transports and heap sampling.
5. Review secret redaction behavior for Processor callbacks and arbitrary
   free-text strings, and verify no credentials are included in artifacts.

At the time of writing, the worktree is local and uncommitted.


## Short bounded soak (Windows)

Reproduction: node bench/soak-3.1.cjs. On ASUS Node 24.8.0, a simulated
slow Transport (2 ms/write) was combined with JSONL output, a 96-record queue
cap, byte-budget checks, explicit DEBUG overflow dropping and a bounded
Flight Recorder.

| Measure | Observed |
| --- | ---: |
| Attempted debug events | 4,800 |
| Delivered to JSONL and Transport | 214 each |
| Dropped by selected DEBUG overflow policy | 4,586 |
| Max queued record count | 96 |
| Queued records after close | 0 |
| Flight Recorder entries after close | 80 |
| Duration | 3.34 seconds |
| RSS first/last sample | 58.8 / 61.4 MiB |

No queue budget was exceeded and the dispatcher drained its accepted work.
This is only a **short bounded pressure check**, not evidence of absence of
a long-term memory leak. The 4,586 dropped messages are intentional test
behavior, not an acceptable default policy for critical application events.
