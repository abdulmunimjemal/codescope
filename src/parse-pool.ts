import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ParseResult } from "./types.js";

interface Pending {
  resolve: (value: { symbols: ParseResult["symbols"]; refs: ParseResult["refs"] }) => void;
  reject: (err: Error) => void;
}

/**
 * A pool of worker threads that parse source in parallel. Parsing dominates
 * index time, so spreading it across cores is the main performance lever.
 *
 * Construction can fail in locked-down environments (no worker support); callers
 * should catch and fall back to in-process {@link parseSource}. The pool never
 * touches SQLite — the main thread owns the database.
 */
export class ParsePool {
  private readonly workers: Worker[];
  private readonly idle: Worker[];
  private readonly queue: Array<{ langId: string; source: string; pending: Pending }> = [];
  private readonly inflight = new Map<Worker, Map<number, Pending>>();
  private nextId = 0;
  private closed = false;

  constructor(size = Math.max(1, availableParallelism() - 1)) {
    const workerUrl = new URL("./parse-worker.js", import.meta.url);
    // Fail fast (so the caller falls back to in-process parsing) when the built
    // worker isn't present — e.g. running from un-built sources, or a packager
    // that didn't ship it.
    if (!existsSync(fileURLToPath(workerUrl))) {
      throw new Error("codescope: parse worker not found; falling back to single-threaded parsing");
    }
    this.workers = [];
    this.idle = [];
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl);
      const pendings = new Map<number, Pending>();
      this.inflight.set(worker, pendings);
      worker.on("message", (msg: { id: number; error?: string; symbols?: unknown; refs?: unknown }) => {
        const pending = pendings.get(msg.id);
        if (!pending) return;
        pendings.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error));
        else
          pending.resolve({
            symbols: msg.symbols as ParseResult["symbols"],
            refs: msg.refs as ParseResult["refs"],
          });
        this.release(worker);
      });
      worker.on("error", (err: Error) => {
        for (const p of pendings.values()) p.reject(err);
        pendings.clear();
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Parse one source string on the next free worker. */
  parse(langId: string, source: string): Promise<{ symbols: ParseResult["symbols"]; refs: ParseResult["refs"] }> {
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      const worker = this.idle.pop();
      if (worker) this.dispatch(worker, langId, source, pending);
      else this.queue.push({ langId, source, pending });
    });
  }

  private dispatch(worker: Worker, langId: string, source: string, pending: Pending): void {
    const id = this.nextId++;
    this.inflight.get(worker)?.set(id, pending);
    worker.postMessage({ id, langId, source });
  }

  private release(worker: Worker): void {
    if (this.closed) return;
    const next = this.queue.shift();
    if (next) this.dispatch(worker, next.langId, next.source, next.pending);
    else this.idle.push(worker);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
