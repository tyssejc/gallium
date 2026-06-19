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
