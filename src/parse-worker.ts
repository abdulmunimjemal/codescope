import { parentPort } from "node:worker_threads";
import { parseSource } from "./parser.js";

/**
 * Worker entry: parse source strings off the main thread. Indexing is
 * parse-bound (~85% of the time), so fanning parsing across cores is the single
 * biggest throughput win. The main thread keeps ownership of SQLite and inserts
 * the results these workers return.
 */

interface ParseRequest {
  id: number;
  langId: string;
  source: string;
}

const port = parentPort;
if (port) {
  port.on("message", (msg: ParseRequest) => {
    parseSource(msg.langId, msg.source)
      .then(({ symbols, refs }) => port.postMessage({ id: msg.id, symbols, refs }))
      .catch((err: unknown) => port.postMessage({ id: msg.id, error: String(err) }));
  });
}
