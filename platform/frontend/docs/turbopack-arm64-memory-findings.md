# Turbopack `next dev` memory growth on Apple Silicon (vercel/next.js#92055)

Why `platform/frontend` keeps `next dev` on **webpack** for macOS arm64 (see
`scripts/dev.mjs`), and the evidence behind it. Turbopack compiles 2.7–4.3× faster
for cold first-paint, so we want it — but on Apple Silicon it grows multi-GB of
non-reclaimable memory during compilation that never recovers, and **no env var,
allocator knob, or config flag we tested bounds it**.

This file is also written to be paste-ready into the upstream issue.

## Environment

| | |
|---|---|
| OS | macOS 26.5 (Darwin 25.5.0) |
| Chip | Apple M1 Pro, 32 GB |
| Node | v22.14.0 (arm64) |
| Next | 16.2.6 (and 16.2.1 / 16.3.0-canary.45 in the minimal repro) |
| App | `platform/frontend`, App Router, ~68 routes (65 `page.tsx` + 3 `route.ts`) |

Measurement gates on **physical footprint** (`vmmap -summary` / `footprint -p`),
the metric macOS jetsam acts on — not the raw `IOAccelerator` virtual size. The
process measured is the `next-server` worker (the one holding
`next-swc.darwin-arm64.node`), isolated from the main dev stack via
`NEXT_DIST_DIR`.

## What the memory actually is (root-cause verdict)

**It is mimalloc data arenas allocated by the SWC/Turbopack engine, kernel-tagged
`IOAccelerator` — not GPU/Metal memory, and not executable JIT pages.**

- The allocator is **mimalloc v3.1.5**, statically linked into
  `next-swc.darwin-arm64.node` (confirmed via `strings`: `purge_delay`,
  `purge_decommits`, `arena_reserve`, `arena_eager_commit`, `abandoned_page_purge`;
  no jemalloc symbols). It honors `MIMALLOC_*` env vars (`MIMALLOC_VERBOSE=1` prints
  its option table). Defaults: `purge_delay=1000` ms, `arena_reserve=1 GiB`,
  `purge_decommits=1`, `abandoned_page_purge=0`.
- `otool -L` on the binary links **only `CoreServices`** — **no Metal, IOKit,
  CoreGraphics, or OpenGL**. SWC therefore cannot be making genuine GPU
  allocations; the `IOAccelerator` tag is the kernel labeling the allocator's
  anonymous `mmap` regions, which matches the maintainer's note that this is
  "memory allocated by the native binary … mapped anonymous memory."
- The growing `IOAccelerator` regions are **dirty data with 0 reclaimable** (see
  `footprint` breakdown below) — they are not clean/droppable and not executable,
  so the original report's "MAP_JIT" framing is a misattribution.
- A 1-second `sample` of the busy process shows the entire hot stack inside
  `next-swc.darwin-arm64.node` (release build, symbols stripped → offsets only).
  `malloc_history` could not attribute the regions to a call site because mimalloc
  reserves arenas via a direct `mmap`/`mach_vm_map` path that bypasses
  MallocStackLogging's hooks. A fully symbolicated allocation backtrace needs a
  debug/source build of `@next/swc`.

## Growth curve — `platform/frontend`, Next 16.2.6, default config

Protocol: launch → sample idle → request all 53 static routes (triggers compile)
→ 40 HMR cycles (edit root `layout.tsx` → request `/agents` + `/chat`) → 120 s idle.

| Stage | phys_footprint | IOAccelerator (dirty / reclaimable) | resident | swapped_out |
|---|---|---|---|---|
| idle (server ready) | 642 MB | ~615 MB / 476 MB | — | — |
| after route sweep | 13.1 GB | 12 GB / **0** | 1.4 GB | 11.8 GB |
| after 40 HMR cycles | 13.3 GB | ~2 GB / 0 | 2.3 GB | ~11 GB |
| **+120 s idle** | **14.1 GB** | 13 GB / **0** | 1.9 GB | 12.2 GB |

The footprint grows monotonically with compilation and **does not recover on idle —
it grew during the idle window.** The resident working set stays low (~1.5–2 GB),
which is why a 32 GB machine survives while the 16 GB machines in the issue OOM:
`phys_footprint` (which counts the 12 GB of swapped-out dirty arenas) is what jetsam
kills on.

`footprint -p` at the post-sweep state:

```
node: 64-bit    Footprint: 13 GB
  12 GB Dirty    0 B Clean    0 B Reclaimable    214 regions    IOAccelerator
 695 MB Dirty    ...                            2374 regions    app-specific tag 16
Writable regions: Total=17.4G written=13.2G(76%) resident=1.4G(8%) swapped_out=11.8G(68%)
```

## Mitigation matrix — every lever is negative or partial

All cells use the identical launch→sweep→churn protocol on `platform/frontend`
(16.2.6), compared on peak phys_footprint. Allocator knobs verified live via
`MIMALLOC_VERBOSE=1`.

| Lever | phys_footprint (post-sweep → end) | Verdict |
|---|---|---|
| default | 13.1 → 13.3 GB | baseline |
| `MIMALLOC_PURGE_DELAY=0` | 13.1 → **13.6 GB** | **worse** — immediate purge defeats page reuse; arenas thrash (RSS also higher) |
| `MIMALLOC_ABANDONED_PAGE_PURGE=1` | 13.1 → 13.3 GB | no effect |
| `experimental.turbopackFileSystemCacheForDev: false` | 12.9 → 13.1 GB | phys_footprint unchanged; only trims the **resident** slice (RSS 662 MB vs 2.3 GB, dirty 519 MB vs 1.7 GB) at the cost of cross-session recompile cache |
| `experimental.turbopackMemoryLimit` | n/a | unimplemented upstream (maintainer-confirmed, slated for removal) |

### Latest canary — partial improvement, not a fix

Upstream minimal repro ([`isaacwasserman/nextjs-ioaccel-repro`](https://github.com/isaacwasserman/nextjs-ioaccel-repro),
5 routes), same app at two versions:

| Version | idle → after sweep+churn | IOAccelerator (dirty / reclaimable) |
|---|---|---|
| 16.2.1 | 1.3 GB → 2.6 GB | 2.2 GB / 3.5 MB |
| **16.3.0-canary.45** | 0.46 GB → **1.6 GB** | 1.2 GB / **116 MB** |

`16.3.0-canary.45` roughly **halves** footprint and finally surfaces some
reclaimable memory — the maintainer's working-set work is partially landing — but
the `IOAccelerator` balloon is still the dominant category and still grows with
compilation. Extrapolated to our ~68 routes that is ~8 GB rather than ~13 GB:
better, still not safe on a 16 GB machine.

## Decision

**Keep webpack as the `next dev` default on macOS arm64** (`scripts/dev.mjs`). The
data does not support flipping the default or baking in a mitigating env, because
none bounds `phys_footprint`. The `ARCHESTRA_DEV_BUNDLER` override and the
`dev:turbo` / `dev:webpack` scripts remain the escape hatches.

A macOS dev who wants Turbopack's speed today and has RAM headroom can
`ARCHESTRA_DEV_BUNDLER=turbopack pnpm dev`; adding
`experimental.turbopackFileSystemCacheForDev: false` cuts the resident working set
~3.5× (it does not bound phys_footprint).

**Revisit trigger:** when a stable Next release ships the upstream working-set fix
(tracked in #92055; canary shows it is in progress), re-run this matrix and flip
macOS arm64 to Turbopack if post-sweep phys_footprint stays within a 16 GB
machine's headroom.

## Reproduce

```bash
cd platform/frontend
NEXT_DIST_DIR=.next-mem ARCHESTRA_DEV_BUNDLER=turbopack pnpm dev:turbo -p 50610
# in another shell, against the next-server PID:
PID=$(lsof -ti:50610 -sTCP:LISTEN | head -1)
vmmap -summary "$PID" | grep -E 'Physical footprint|IOAccelerator'
footprint -p "$PID"            # IOAccelerator Dirty vs Reclaimable
# request routes / edit a shared file to drive compilation, then re-measure;
# wait 2 min idle and re-measure — phys_footprint does not recover.
```
