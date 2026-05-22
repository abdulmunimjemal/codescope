#!/usr/bin/env node
// Head-to-head: codescope vs codegraph (@colbymchenry/codegraph) on the same repo.
//
// Measures the axes that don't need an LLM and are startup-independent where it
// matters: full-index wall time, on-disk index size, and — the core value
// metric — tokens returned per equivalent answer (definition lookup + callers).
// Both tools are invoked through their CLIs for a fair comparison.
//
// Usage: node bench/vs-codegraph.mjs <repo-path>
// Requires network on first run (npx fetches codegraph; cached afterwards).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";
import { GraphStore } from "../dist/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const CG = ["-y", "@colbymchenry/codegraph@latest"];
const TOK = (s) => (s ? encode(s).length : 0);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function timed(fn) {
  const t = Number(process.hrtime.bigint() / 1000n) / 1000;
  fn();
  return Number(process.hrtime.bigint() / 1000n) / 1000 - t;
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return e.stdout ?? "";
  }
}

function dirSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fmtBytes(b) {
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`;
}

function pickTerms(dbPath, n) {
  const store = new GraphStore(dbPath);
  const rows = store.db
    .prepare(
      `SELECT s.name, COUNT(r.id) AS callers
       FROM symbols s LEFT JOIN refs r ON r.name = s.name AND r.kind IN ('call','method')
       WHERE s.kind IN ('function','method','class') AND length(s.name) >= 4
       GROUP BY s.name ORDER BY callers DESC LIMIT ?`,
    )
    .all(n * 3);
  store.close();
  // spread across the popularity range
  const step = Math.max(1, Math.floor(rows.length / n));
  const out = [];
  for (let i = 0; i < rows.length && out.length < n; i += step) out.push(rows[i].name);
  return out;
}

async function main() {
  const repo = resolve(process.argv[2] ?? ".");
  const name = basename(repo);
  console.log(`\n=== codescope vs codegraph — ${name} ===`);

  // Warm the npx cache so codegraph timings aren't dominated by a one-time fetch.
  run("npx", [...CG, "--version"], repo);

  // ---- full index ----
  const csDb = join(mkdtempSync(join(tmpdir(), "cs-vs-")), "graph.db");
  const csIndexMs = timed(() => run("node", [CLI, "index", repo, "--db", csDb], repo));
  const csSize = dirSize(csDb);

  run("npx", [...CG, "uninit", repo], repo); // clean any prior state
  const cgIndexMs = timed(() => run("npx", [...CG, "init", "-i", repo], repo));
  const cgSize = dirSize(join(repo, ".codegraph", "codegraph.db"));

  // ---- tokens per answer (identical queries) ----
  const terms = pickTerms(csDb, 15);
  let csDefTok = 0, cgDefTok = 0, csCallTok = 0, cgCallTok = 0, pairs = 0;
  for (const t of terms) {
    const csDef = run("node", [CLI, "search", t, "--db", csDb, "--limit", "5"], repo);
    const cgDef = stripAnsi(run("npx", [...CG, "query", t, "-p", repo, "-l", "5"], repo));
    const csCall = run("node", [CLI, "callers", t, "--db", csDb, "--limit", "10"], repo);
    const cgCall = stripAnsi(run("npx", [...CG, "callers", t, "-p", repo, "-l", "10"], repo));
    if (!cgDef.trim()) continue;
    pairs++;
    csDefTok += TOK(csDef);
    cgDefTok += TOK(cgDef);
    csCallTok += TOK(csCall);
    cgCallTok += TOK(cgCall);
  }

  // ---- cleanup ----
  rmSync(join(csDb, ".."), { recursive: true, force: true });
  run("npx", [...CG, "uninit", repo], repo);
  rmSync(join(repo, ".codegraph"), { recursive: true, force: true });

  const winner = (cs, cg, lowerIsBetter = true) => {
    const better = lowerIsBetter ? cs < cg : cs > cg;
    return better ? "codescope ✓" : "codegraph ✓";
  };

  console.log(`\n  full index (CLI wall):  codescope ${csIndexMs.toFixed(0)}ms  vs  codegraph ${cgIndexMs.toFixed(0)}ms   → ${winner(csIndexMs, cgIndexMs)}`);
  console.log(`  index size on disk:     codescope ${fmtBytes(csSize)}  vs  codegraph ${fmtBytes(cgSize)}   → ${winner(csSize, cgSize)}`);
  console.log(`  tokens/definition ans:  codescope ${(csDefTok / pairs).toFixed(0)}  vs  codegraph ${(cgDefTok / pairs).toFixed(0)}  (avg over ${pairs}) → ${winner(csDefTok, cgDefTok)}`);
  console.log(`  tokens/callers ans:     codescope ${(csCallTok / pairs).toFixed(0)}  vs  codegraph ${(cgCallTok / pairs).toFixed(0)}  (avg over ${pairs}) → ${winner(csCallTok, cgCallTok)}`);
  console.log(`\n  (index wall includes node/npx startup for both; tokens are startup-independent and are the core value metric.)`);
}

main();
