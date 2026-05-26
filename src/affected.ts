import type { GraphStore } from "./store.js";

/**
 * Heuristics for "is this a test file", across the languages codescope supports.
 * Deliberately broad — a false positive (flagging a non-test) is cheaper for an
 * agent than missing a test that should run.
 */
const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|spec|specs|__tests__|e2e|integration)\//i,
  /\.(test|spec)\.[a-z]+$/i, // foo.test.ts, foo.spec.js
  /_test\.[a-z]+$/i, // foo_test.go, foo_test.py, foo_test.rs
  /(^|\/)test_[^/]+\.(py|rb)$/i, // test_foo.py
  /(Test|Tests|Spec)\.[a-z]+$/i, // FooTest.java, FooTests.cs, FooSpec.scala
  /_spec\.rb$/i, // foo_spec.rb
];

/** Whether a repo-relative path looks like a test file. */
export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

export interface AffectedResult {
  changed: string[];
  /** Every file that defines a symbol transitively affected by the changes. */
  impactedFiles: string[];
  /** The impacted files that look like tests — the suite worth re-running. */
  tests: string[];
}

/**
 * Given a set of changed files, compute which test files are likely affected:
 * collect the symbols defined in the changed files, walk their transitive
 * callers, and keep the test files among the results. Answers "what should I
 * re-run?" without executing anything.
 */
/** The module basename a file is imported as: `src/store.ts` → `store`. */
function moduleBasename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

export function affected(
  store: GraphStore,
  changedPaths: string[],
  opts: { depth?: number } = {},
): AffectedResult {
  const depth = opts.depth ?? 4;
  const impactedFiles = new Set<string>(changedPaths);

  // Signal 1 — call graph: transitive callers of the changed files' symbols.
  for (const path of changedPaths) {
    for (const sym of store.fileOutline(path)) {
      for (const caller of store.impact(sym.name, { depth })) {
        impactedFiles.add(caller.file);
      }
    }
  }

  // Signal 2 — import graph: files that (transitively) import the changed
  // files. This is what reliably reaches test files, since a test imports the
  // module it exercises even when it never appears in the call graph.
  let frontier = [...changedPaths];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const importer of store.findImporters(moduleBasename(path))) {
        if (!impactedFiles.has(importer)) {
          impactedFiles.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }

  return {
    changed: changedPaths,
    impactedFiles: [...impactedFiles].sort(),
    tests: [...impactedFiles].filter(isTestFile).sort(),
  };
}
