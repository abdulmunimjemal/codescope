import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, install, installInto, serverEntry } from "../src/install.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codescope-install-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readConfig(path: string): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("install", () => {
  it("writes a valid MCP server entry for each agent", () => {
    const results = install(dir, { agents: ["claude", "cursor"] });
    expect(results.map((r) => r.action)).toEqual(["added", "added"]);

    const claude = readConfig(configPath("claude", dir));
    expect(claude.mcpServers?.codescope).toEqual(serverEntry());

    const cursor = readConfig(configPath("cursor", dir));
    expect(cursor.mcpServers?.codescope).toEqual(serverEntry());
  });

  it("is idempotent and preserves other servers", () => {
    const path = configPath("claude", dir);
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    const [first] = install(dir, { agents: ["claude"] });
    expect(first?.action).toBe("added"); // codescope was not present yet
    expect(Object.keys(readConfig(path).mcpServers ?? {}).sort()).toEqual(["codescope", "other"]);

    // running again updates the existing entry, still preserving `other`
    const [second] = install(dir, { agents: ["claude"] });
    expect(second?.action).toBe("updated");
    expect(Object.keys(readConfig(path).mcpServers ?? {}).sort()).toEqual(["codescope", "other"]);
  });

  it("does not corrupt an existing file with invalid JSON", () => {
    const path = configPath("cursor", dir);
    const outcome = installInto("cursor", dir);
    expect(outcome.action).toBe("added");
    expect(readConfig(path).mcpServers?.codescope).toBeDefined();
  });
});
