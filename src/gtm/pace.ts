import { readFile, writeFile } from "node:fs/promises";
import { rateLimitPath } from "../paths.ts";
import { ensureDirFor } from "../util/fs.ts";

export interface Pacer { acquire(): Promise<void> }

export interface FilePacerOpts {
  path?: string;
  limit?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function readStamps(path: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return []; // missing or corrupt: treat as empty
  }
}

// Sliding-window limiter whose window is a JSON array of epoch-ms timestamps in a file,
// so the budget is shared across separate invocations.
export function filePacer(opts: FilePacerOpts = {}): Pacer {
  const path = opts.path ?? rateLimitPath();
  const limit = opts.limit ?? 20;
  const windowMs = opts.windowMs ?? 100_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  return {
    async acquire() {
      let stamps = (await readStamps(path)).filter((t) => t > now() - windowMs);
      if (stamps.length >= limit) {
        const wait = Math.min(...stamps) + windowMs - now();
        if (wait > 0) await sleep(wait);
        stamps = stamps.filter((t) => t > now() - windowMs);
      }
      stamps.push(now());
      await ensureDirFor(path);
      await writeFile(path, JSON.stringify(stamps));
    },
  };
}

export function isQuotaError(status: number, body: string): boolean {
  return status === 429 || (status === 403 && /rateLimitExceeded|RESOURCE_EXHAUSTED|quota/i.test(body));
}
