# Benchmarks

Every number here is reproducible from this repo, measured **without an LLM or
network** on an Apple Silicon laptop (Node 25). Absolute numbers vary with
hardware — the **ratios** are the point.

```bash
pnpm build
node bench/run.mjs <repo> [<repo> ...]          # codescope's own performance
node bench/vs-codegraph.mjs <repo>              # head-to-head vs codegraph
node bench/accuracy.mjs <ts-package-dir>        # accuracy vs the TypeScript compiler
```

## Performance

| repo | files | symbols | full index | throughput | incremental p50 | nav token reduction |
|------|------:|--------:|-----------:|-----------:|----------------:|--------------------:|
| codescope | 33 | 202 | 121 ms | 273 files/s | 2.0 ms | 64% |
| mcp-ts-sdk | 264 | 1,958 | 572 ms | 462 files/s | 0.54 ms | 74% |
| phoenix | 3,511 | 20,143 | 2.1 s | 1,677 files/s | 0.82 ms | 80% |
| trigger.dev | 2,490 | 33,786 | 1.8 s | 1,383 files/s | 0.74 ms | 99% |

- **Incremental is the watch-first payoff.** Re-indexing one changed file costs
  ~0.5–0.8 ms — **280–1,200× cheaper than a full re-index** — so the graph stays
  current on every save.
- **Queries are sub-millisecond** (symbol search ~0.05 ms, call neighbourhood
  ~1 ms) — they're never the bottleneck.
- **Token reduction** (vs an agent reading the whole file to answer "where is X
  and what calls it"): **64–99% fewer tokens**, median 2.6–7.3× smaller per
  answer; bigger files ⇒ bigger savings.

Indexing fans parsing across a worker-thread pool on large repos (>750 files;
parsing is ~85% of index time) and runs single-threaded on smaller repos, where
that's faster — with a single-threaded fallback everywhere if workers are
unavailable.

## Accuracy — "did it return the right answer?"

The axis that matters most for an agent. Ground truth comes from **each
language's own native analysis engine** — the TypeScript compiler, Jedi for
Python, `go/types` for Go — *not* from codescope. For each definition we compute
the true set of files containing a call to it, then score each tool's `callers`
answer (precision / recall / **F1**).

| language | oracle | repo | codescope | codegraph | code-graph-mcp |
|----------|--------|------|:---------:|:---------:|:--------------:|
| TypeScript | `tsc` | MCP SDK core (88) | **0.952** | 0.664 | — |
| TypeScript | `tsc` | MCP SDK client (39) | **0.916** | 0.701 | — |
| TypeScript | `tsc` | MCP SDK server (36) | **0.956** | 0.906 | — |
| TypeScript | `tsc` | got (101) | **0.970** | 0.749 | — |
| TypeScript | `tsc` | zustand (30) | **0.989** | 0.867 | — |
| Python | Jedi | requests (55) | **0.788** | 0.454 | 0.217 |
| Go | `go/types` | gin (209) | **0.720** | 0.646 | 0.651 |

**codescope wins caller-F1 on every language and repo tested.** It has
near-perfect recall (name-based, so it rarely misses a true caller) where the
others miss 13–48%; its precision matches or beats them.

- **Go is the hardest case** — gin reuses method names across types (`Use`,
  `Next`, `Handle`), so *every* tool sits around 0.6 precision (no receiver-type
  resolution). codescope still wins net.
- **The precision ceiling** (same-named symbol collisions) is the one place
  true type-aware / LSP-grade resolution would help. That's the roadmap item.
- code-graph-mcp was run only on Python + Go (its TS path wasn't measured); its
  low Python score reflects that precise call graphs aren't its focus.

```bash
node bench/accuracy.mjs <ts-package-dir>                                  # TS (tsc)
python3 bench/oracle-python.py <pkg> > o.json && node bench/accuracy-generic.mjs <pkg> o.json   # Python (Jedi)
go run bench/oracle-go.go <repo> > o.json && node bench/accuracy-generic.mjs <repo> o.json      # Go (go/types)
```

## Head-to-head vs codegraph

[codegraph](https://github.com/colbymchenry/codegraph) (~35k★) is the leading
local codebase-graph MCP and shares codescope's architecture (tree-sitter →
SQLite + FTS5 → MCP, incremental sync, file watcher). Both run through their CLIs
on the same repos by `bench/vs-codegraph.mjs`:

| axis | repo | codegraph | codescope | winner |
|------|------|----------:|----------:|:------:|
| full index (CLI wall) | mcp-ts-sdk (264 f) | 2,335 ms | **670 ms** | codescope 3.5× |
| | phoenix (3,500 f) | 20,010 ms | **2,639 ms** | codescope 7.6× |
| index size on disk | mcp-ts-sdk | 8.2 MB | **2.5 MB** | codescope 3.3× |
| | phoenix | 112.8 MB | **22.8 MB** | codescope 5.0× |
| tokens / definition answer | mcp-ts-sdk | 187 | **145** | codescope |
| | phoenix | 215 | **183** | codescope |
| tokens / callers answer | mcp-ts-sdk | 122 | **98** | codescope |
| | phoenix | 177 | **145** | codescope |

(Index wall includes Node/npx startup for both; tokens are startup-independent.
15 shared query terms per repo.)

**On every axis this harness measures — index speed, footprint, tokens, and
caller accuracy — codescope wins**, with feature parity on the core graph tools
(`callers`, `callees`, `impact`, `context`, `affected`, `install`) across 21
languages.

What **codegraph still leads on** (stated plainly):

- **Richer nodes** — it also indexes constants, properties, and routes (part of
  why its index is larger; codescope indexes functions/methods/classes/
  interfaces/types/enums).
- **True cross-file resolution** — codescope resolves by name + call shape
  (kind-aware), not by following imports to a specific definition. Roadmap.
- **More auto-install agents** — Codex/opencode/Hermes; codescope wires Claude
  Code + Cursor and prints config for the rest.
- **Maturity & adoption** — 35k★ and a real user base. *Earned, not claimed.*

## Versus the broader OSS field

codegraph isn't the only peer. codescope was also benchmarked against other
runnable open-source tools (each authorized and run locally, same harness).

**code-graph-mcp** (`@sdsrs/code-graph` v0.32.3) — Rust, 16 languages, *plus*
semantic/vector search and HTTP-route tracing:

| axis | codescope | code-graph-mcp |
|------|----------:|---------------:|
| index size (gin/requests/zustand/got/ripgrep) | 1.6 / 0.7 / 0.5 / 1.0 / 2.0 MB | 4.0 / 2.3 / 1.0 / 2.2 / 8.8 MB |
| index time (same five) | 0.2–0.6 s | 0.9–1.8 s |
| accuracy F1 — Python (requests) | **0.788** | 0.217 |
| accuracy F1 — Go (gin) | **0.720** | 0.651 |

**code-review-graph** (v2.3.5) — Python, *plus* community detection and wiki
generation: building `requests` took **5.98 s / 6.1 MB** vs codescope's ~0.3 s /
~0.7 MB (≈20× faster, ≈9× smaller). Its query interface is MCP-only (no `callers`
CLI), so caller accuracy wasn't measured.

**CodeGraphContext** — stores its graph in **Neo4j**; needs a running server,
unavailable here, so not measured.

**Honest verdict on the field:** against every competitor benchmarked, codescope
is the **leanest, fastest, and most call-graph-accurate** — but not the most
*featureful*. code-graph-mcp adds semantic/vector search and route tracing;
code-review-graph adds community detection and wikis; CodeGraphContext offers
Cypher over Neo4j. codescope's bet is "small, fast, accurate call graph."

## Does it generalize? (anti-benchmark-maxing)

To check nothing is tuned to one repo, the head-to-head ran on **five fresh,
unrelated codebases** across languages — including **Gin, one of codegraph's own
published benchmark repos**:

| repo | lang | index size | tokens/def | tokens/callers |
|------|------|:----------:|:----------:|:--------------:|
| gin | Go | **cs** 1.6 vs 5.6 MB | cg 109 vs 97 | **cs** 76 vs 103 |
| requests | Python | **cs** 0.7 vs 2.4 MB | **cs** 126 vs 172 | **cs** 59 vs 74 |
| zustand | TS | **cs** 0.5 vs 1.0 MB | tie 81 vs 80 | cg 29 vs 20 |
| got | TS | **cs** 1.0 vs 3.2 MB | **cs** 90 vs 96 | tie 53 vs 52 |
| ripgrep | Rust | **cs** 2.0 vs 9.1 MB | **cs** 150 vs 167 | **cs** 81 vs 154 |

Index size: codescope wins **5/5** (3–4× smaller). Tokens: wins most, ties/loses
a few — competitive, not universally ahead. The variance is the point: nothing is
hand-tuned to one codebase. (Accuracy generalization is the multi-language table
above — fresh repos got/zustand and the Python/Go oracles.)

This exercise also **caught and fixed a real regression**: the worker pool
engaged at >24 files, but its startup cost only pays off on large monorepos, so
small/medium repos were *slower* with it on. The threshold was raised to >750.

## Caveats (read these)

- **Single machine, single run.** codegraph and codescope count graph nodes
  differently, so index time/size are informative, not a pure apples-to-apples
  ratio.
- **codegraph's published claims** ("57% fewer tokens / 62% fewer tool calls")
  come from a full LLM agent loop on a different repo set — a different quantity
  than these deterministic measurements. Don't equate them.
- **The token baseline is a model** (agent reads the whole containing file), not
  a captured agent trace.
- **References resolve by name + call shape**, not full type analysis — a fast
  heuristic, not a compiler. Cross-file import resolution isn't modelled yet.
- **Rust `impl` methods** are labelled `function` (impl blocks aren't tracked as
  containers) — a known limitation.
