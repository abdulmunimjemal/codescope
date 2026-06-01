#!/usr/bin/env node
// Generic accuracy comparator: score codescope vs codegraph `callers` against a
// precomputed ground-truth oracle (from any language's analysis engine).
//
// Usage: node bench/accuracy-generic.mjs <repo-dir> <oracle.json>
// oracle.json: [{ "name": string, "callerFiles": string[] }] (repo-relative).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { GraphStore, Indexer } from "../dist/index.js";

const CG = ["-y", "@colbymchenry/codegraph@latest"];
const root = resolve(process.argv[2]);
const oracle = JSON.parse(readFileSync(process.argv[3], "utf8"));

function f1(p, r) {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}
function score(returned, truth) {
  let correct = 0;
  for (const f of returned) if (truth.has(f)) correct++;
  const precision = returned.size === 0 ? 0 : correct / returned.size;
  const recall = truth.size === 0 ? 0 : correct / truth.size;
  return { precision, recall, f1: f1(precision, recall) };
}

function codegraphCallers(name) {
  try {
    const out = execFileSync("npx", [...CG, "callers", name, "-p", root, "-l", "200", "-j"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const json = JSON.parse(out.replace(/\x1b\[[0-9;]*m/g, ""));
    const arr = Array.isArray(json) ? json : (json.callers ?? json.results ?? []);
    const files = new Set();
    for (const c of arr) {
      const f = c.filePath ?? c.file ?? c.path ?? c.location?.file;
      if (f) files.add(relative(root, resolve(root, f)));
    }
    return files;
  } catch {
    return new Set();
  }
}

async function main() {
  console.log(`\n=== accuracy (oracle ground truth) — ${relative(process.cwd(), root) || root} ===`);

  const store = new GraphStore(":memory:");
  await new Indexer(store, root).indexAll();

  execFileSync("npx", [...CG, "--version"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("npx", [...CG, "uninit", root], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("npx", [...CG, "init", "-i", root], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });

  const agg = { cs: { p: 0, r: 0, f: 0, n: 0 }, cg: { p: 0, r: 0, f: 0, n: 0 } };
  for (const def of oracle) {
    const truth = new Set(def.callerFiles);
    if (truth.size === 0) continue;
    const cs = score(new Set(store.findCallers(def.name, { limit: 200 }).map((x) => x.file)), truth);
    const cg = score(codegraphCallers(def.name), truth);
    agg.cs.p += cs.precision; agg.cs.r += cs.recall; agg.cs.f += cs.f1; agg.cs.n++;
    agg.cg.p += cg.precision; agg.cg.r += cg.recall; agg.cg.f += cg.f1; agg.cg.n++;
  }

  execFileSync("npx", [...CG, "uninit", root], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  store.close();

  const rep = (label, a) =>
    console.log(`  ${label.padEnd(10)} precision=${(a.p / a.n).toFixed(3)}  recall=${(a.r / a.n).toFixed(3)}  F1=${(a.f / a.n).toFixed(3)}  (n=${a.n})`);
  rep("codescope", agg.cs);
  rep("codegraph", agg.cg);
  const cs = agg.cs.f / agg.cs.n, cg = agg.cg.f / agg.cg.n;
  console.log(`\n  → ${cs >= cg ? "codescope ✓ (>= codegraph)" : "codegraph ahead"}  (F1 ${cs.toFixed(3)} vs ${cg.toFixed(3)})`);
}

main();
