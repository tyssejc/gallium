import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAccessToken } from "./token.ts";

test("getAccessToken caches until near expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-tok-"));
  const cachePath = join(dir, "acme.json");
  let calls = 0;
  const refresher = async () => { calls++; return { access_token: `t${calls}`, expires_in: 3600 }; };
  try {
    const a = await getAccessToken({ cachePath, nowMs: 0, refresher });
    const b = await getAccessToken({ cachePath, nowMs: 60_000, refresher }); // still fresh
    expect(a).toBe("t1"); expect(b).toBe("t1"); expect(calls).toBe(1);
    const c = await getAccessToken({ cachePath, nowMs: 3_600_000, refresher }); // expired
    expect(c).toBe("t2"); expect(calls).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("getAccessToken respects 5-minute expiry buffer boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-tok-"));
  const cachePath = join(dir, "buffer.json");
  let calls = 0;
  const refresher = async () => { calls++; return { access_token: `b${calls}`, expires_in: 3600 }; };
  try {
    // Seed cache at nowMs:0, token expires at 3_600_000
    await getAccessToken({ cachePath, nowMs: 0, refresher });
    expect(calls).toBe(1);

    // At nowMs = 3_300_000 (5 min = 300_000 ms before expiry): inside buffer, should refresh
    await getAccessToken({ cachePath, nowMs: 3_300_000, refresher });
    expect(calls).toBe(2);

    // At nowMs = 3_299_000 (just outside buffer): should NOT refresh
    const result = await getAccessToken({ cachePath, nowMs: 3_299_000, refresher });
    expect(result).toBe("b2");
    expect(calls).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
