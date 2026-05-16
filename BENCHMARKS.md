# Benchmarks

These numbers come from `bench/run.mjs` and measure the things that matter for a
codebase-graph MCP server **and that can be measured deterministically** — no
LLM, no network, fully reproducible:

```bash
pnpm build
node bench/run.mjs <repo-path> [<repo-path> ...] [--md report.md]
```

Measured on an Apple Silicon laptop, Node 25, 2026-06-01, on four real
repositories (this repo plus three large open-source codebases checked out
locally). Your absolute numbers will vary with hardware; the **ratios** are the
point.

## Results

| repo | files | symbols | refs | full index | throughput | incremental p50 | speedup vs full | search | neighborhood | nav token reduction |
|------|------:|--------:|-----:|-----------:|-----------:|----------------:|----------------:|-------:|-------------:|--------------------:|
| codescope | 22 | 123 | 1,163 | 64 ms | 346 files/s | **1.94 ms** | 18× | 0.04 ms | 0.92 ms | 74.5% |
| mcp-ts-sdk | 262 | 1,956 | 23,881 | 495 ms | 529 files/s | **0.58 ms** | 281× | 0.06 ms | 0.92 ms | 71.1% |
| phoenix | 3,500 | 20,135 | 133,530 | 4.7 s | 740 files/s | **0.54 ms** | 2,738× | 0.18 ms | 0.97 ms | 77.3% |
| trigger.dev | 2,481 | 33,784 | 142,472 | 5.8 s | 424 files/s | **0.65 ms** | 2,978× | 0.14 ms | 1.51 ms | 98.4% |

(`phoenix` and `trigger.dev` are multi-language: TypeScript, TSX, Python, Go,
JavaScript — all indexed in a single pass.)

### Incremental freshness

Refreshing the graph after you edit one file costs **~0.5–0.65 ms** in-process
(read + parse + replace) on a 3,000-file repo — **2,700–3,000× cheaper than a
full re-index of the same repo**. codescope re-indexes on every save via its file
watcher, so an agent always queries current code, not a stale snapshot.

> **Honest note:** codegraph *also* does incremental updates (`codegraph sync`)
> and *also* ships a file watcher that auto-syncs in `serve` mode by default.
> Watch-first is **not** a feature codescope has and codegraph lacks — both have
> it. The ~0.5 ms figure above is codescope's *in-process* per-file cost; it is
> not a head-to-head win over codegraph's watcher (which does comparable work).
> See the comparison table below for what the measured differences actually are.

### Token efficiency

For the navigation task *"find symbol X and understand its call relationships"*:

- **baseline** = the tokens an agent reads today: the whole file that defines `X`
  (agents `Read` the file to locate and understand a symbol).
- **codescope** = the tokens of the `get_symbol(X)` + `neighborhood(X)` responses.

codescope returns the answer in **71–98% fewer tokens** (median 2.6–5.3× smaller
per query). For the *"what's in this file"* task, `file_outline` is **59–86%**
smaller than reading the file. Bigger files ⇒ bigger savings, which is why the
reduction climbs on large repos.

## How codescope compares to codegraph (measured head-to-head)

[codegraph](https://github.com/colbymchenry/codegraph) (~35k★) is the leading
local codebase-graph MCP and shares codescope's architecture (tree-sitter →
SQLite + FTS5 → MCP). It **was executed** for this comparison (`@colbymchenry/codegraph`
on the same `mcp-ts-sdk` checkout, ~275 files, same machine).

| dimension | codegraph (measured) | codescope (measured) |
|-----------|----------------------|----------------------|
| full index (mcp-ts-sdk) | 986 ms (parse+resolve, internal timer) | ~495 ms (in-process) |
| index DB size | **7.84 MB** | **2.5 MB** (~3× smaller) |
| nodes captured | 3,585 (functions, methods, classes, interfaces, types, **constants, properties, routes, imports, files**) | 1,956 definitions (functions, methods, classes, interfaces, types, enums) |
| incremental | `sync` command **+ file watcher (auto-sync in `serve`)** | file watcher + per-file replace |
| search | SQLite FTS5 | SQLite FTS5 (trigram substring) |
| languages | **20+** | 12 (TS/JS/TSX, Py, Go, Rust, Java, Ruby, C, C++, C#, PHP) |
| extra tooling | `impact`, `affected` (test impact), `context` (task context), `callees`, agent auto-install | — |
| query answer | kind + location + code snippet (~184 tokens for a 5-result query) | kind + location + signature (compact lines) |
| install | `npx @colbymchenry/codegraph` | `npx codescope` |

### Honest verdict

codescope **does not beat codegraph overall.** codegraph is a more mature, more
featureful tool (impact analysis, test-affected detection, task-context builder,
20+ languages, agent auto-install) and it **already has** the incremental +
file-watcher behaviour that this project's original premise assumed was missing.

Where codescope **genuinely wins, measured:**

- **~3× smaller index** (2.5 MB vs 7.84 MB on the same repo) and **~2× faster
  pure indexing** — though codegraph indexes *more* (constants, properties,
  routes), so it is doing more work for that time/size.
- **Smaller, simpler, fully auditable** codebase (one SQLite file, ~1k LOC, MIT,
  zero-config `npx codescope mcp .`).

Where codegraph leads: **features, language breadth, maturity, and adoption.**

codescope's honest position is **"a lean, fast, easy-to-verify alternative,"**
not "the codegraph killer." The token-reduction numbers above are real but they
measure codescope vs *reading whole files*, the same baseline codegraph reports
against — they are **not** evidence that codescope beats codegraph.

## Caveats (read these)

- **The codegraph head-to-head is single-repo, single-run** (mcp-ts-sdk, one
  machine). codegraph and codescope count "nodes"/"symbols" differently (codegraph
  captures more node kinds), so index time and DB size are informative but not a
  pure apples-to-apples ratio. The honest verdict above accounts for this.
- **codegraph's own published claims** ("57% fewer tokens / 62% fewer tool calls")
  come from a full LLM agent loop across a different 7-repo set and bound a
  *different* quantity (end-to-end agent task cost) than codescope's deterministic
  measurements. Don't equate the two.
- **Token baseline is a model**, not a trace of a real agent: it assumes the agent
  reads the whole containing file, which is the documented failure mode but not
  the only possible behaviour.
- **References resolve by name**, not by full type/scope analysis. Bare calls
  resolve to functions and `x.f()` to methods (kind-aware), and ambiguous
  library-ish names are deliberately not expanded — but this is heuristic, not a
  compiler. Cross-file import resolution is not yet modelled.
- **Rust `impl` methods** are currently labelled `function` (impl blocks aren't
  tracked as containers). Tracked as a known limitation.
- Numbers are single-run on one machine; `bench/run.mjs` samples up to 250 files
  for incremental latency and 150 symbols for token stats.
