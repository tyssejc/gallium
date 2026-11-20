import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePacer, isQuotaError } from "./pace.ts";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "gallium-pace-")), "sub", ".ratelimit.json");
}

test("allows up to the limit without sleeping", async () => {
  const sleeps: number[] = [];
  const p = filePacer({ path: tmpPath(), limit: 3, now: () => 1_000, sleep: async (ms) => { sleeps.push(ms); } });
  await p.acquire(); await p.acquire(); await p.acquire();
  expect(sleeps).toEqual([]);
});

test("sleeps until the oldest entry leaves the window", async () => {
  const sleeps: number[] = [];
  let t = 1_000;
  const p = filePacer({ path: tmpPath(), limit: 2, windowMs: 100_000, now: () => t, sleep: async (ms) => { sleeps.push(ms); } });
  await p.acquire(); await p.acquire();
  t = 31_000;
  await p.acquire();
  expect(sleeps).toEqual([70_000]);
});

test("a second pacer on the same file sees the first one's requests", async () => {
  const path = tmpPath();
  const sleeps: number[] = [];
  const opts = { path, limit: 1, windowMs: 100_000, now: () => 5_000, sleep: async (ms: number) => { sleeps.push(ms); } };
  await filePacer(opts).acquire();
  await filePacer(opts).acquire();
  expect(sleeps).toEqual([100_000]);
});

test("a missing or corrupt file is treated as empty", async () => {
  const path = tmpPath();
  const p = filePacer({ path, limit: 1, now: () => 1, sleep: async () => { throw new Error("should not sleep"); } });
  await p.acquire();
  const path2 = tmpPath();
  await filePacer({ path: path2 }).acquire();
  writeFileSync(path2, "not json");
  await filePacer({ path: path2, limit: 1, now: () => 1, sleep: async () => { throw new Error("should not sleep"); } }).acquire();
});

test("isQuotaError", () => {
  expect(isQuotaError(429, "")).toBe(true);
  expect(isQuotaError(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}')).toBe(true);
  expect(isQuotaError(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}')).toBe(true);
  expect(isQuotaError(403, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBe(true);
  expect(isQuotaError(403, "insufficient quota to proceed")).toBe(true);
  expect(isQuotaError(403, '{"error":{"status":"PERMISSION_DENIED","message":"insufficient permissions"}}')).toBe(false);
  expect(isQuotaError(500, "quota")).toBe(false);
});

test("onWait is called before a sleep longer than 5 s, and not for a short one", async () => {
  const waits: number[] = [];
  let t = 1_000;
  const p = filePacer({ path: tmpPath(), limit: 1, windowMs: 100_000, now: () => t,
    sleep: async () => {}, onWait: (ms) => { waits.push(ms); } });
  await p.acquire();
  t = 31_000;
  await p.acquire();             // waits 70 s
  expect(waits).toEqual([70_000]);
  t = 127_000;                   // oldest stamp in the window is 31_000 → waits 4 s
  await p.acquire();
  expect(waits).toEqual([70_000]);
});
