import { beforeEach, describe, expect, it } from "vitest";
import { affected, isTestFile } from "../src/affected.js";
import { GraphStore } from "../src/store.js";
import type { ParsedRef, ParsedSymbol } from "../src/types.js";

function sym(name: string): ParsedSymbol {
  return {
    name,
    kind: "function",
    container: null,
    exported: true,
    signature: null,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    startByte: 0,
    endByte: 0,
  };
}

function imp(spec: string): ParsedRef {
  return { fromSymbol: null, name: spec, kind: "import", startRow: 0, startCol: 0 };
}

describe("isTestFile", () => {
  it("recognises common test conventions across languages", () => {
    for (const p of [
      "test/foo.test.ts",
      "src/__tests__/foo.ts",
      "pkg/foo_test.go",
      "tests/test_foo.py",
      "src/FooTest.java",
      "spec/foo_spec.rb",
    ]) {
      expect(isTestFile(p), p).toBe(true);
    }
    for (const p of ["src/foo.ts", "lib/util.py", "main.go"]) {
      expect(isTestFile(p), p).toBe(false);
    }
  });
});

describe("affected", () => {
  let store: GraphStore;
  beforeEach(() => {
    store = new GraphStore(":memory:");
    // a source module
    store.replaceFile(
      { path: "src/util.ts", lang: "typescript", hash: "h1", size: 1, mtime: 0 },
      [sym("doThing")],
      [],
      1,
    );
    // a test that imports the module under test
    store.replaceFile(
      { path: "test/util.test.ts", lang: "typescript", hash: "h2", size: 1, mtime: 0 },
      [sym("describeBlock")],
      [imp("../src/util")],
      1,
    );
    // an unrelated test
    store.replaceFile(
      { path: "test/other.test.ts", lang: "typescript", hash: "h3", size: 1, mtime: 0 },
      [sym("otherBlock")],
      [imp("../src/other")],
      1,
    );
  });

  it("finds tests that import a changed file (import-graph reachability)", () => {
    const result = affected(store, ["src/util.ts"]);
    expect(result.tests).toContain("test/util.test.ts");
    expect(result.tests).not.toContain("test/other.test.ts");
  });

  it("reports nothing when no tests are reachable", () => {
    store.replaceFile(
      { path: "src/lonely.ts", lang: "typescript", hash: "h4", size: 1, mtime: 0 },
      [sym("lonely")],
      [],
      1,
    );
    expect(affected(store, ["src/lonely.ts"]).tests).toEqual([]);
  });
});
