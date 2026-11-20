import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAccessToken, getUserToken, assertWriteAllowed, oauthRefreshPath, oauthScopePath } from "./token.ts";
import { TAGMANAGER_READONLY_SCOPE, TAGMANAGER_EDIT_CONTAINERS_SCOPE } from "./oauth.ts";

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

test("getUserToken throws 'Not logged in' when oauth is configured but no refresh token file exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-tok-"));
  const orig = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    await expect(getUserToken({ oauth: { client_id: "c", client_secret: "s" }, containers: {} }))
      .rejects.toThrow(/Not logged in/);
  } finally {
    if (orig === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getUserToken throws 'No credentials' for an empty config", async () => {
  await expect(getUserToken({ containers: {} })).rejects.toThrow(/No credentials/);
});

async function withCache(setup: (() => void) | null, fn: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gallium-write-"));
  const orig = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try { setup?.(); await fn(); }
  finally {
    if (orig === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = orig;
    rmSync(dir, { recursive: true, force: true });
  }
}
function writeTokenFiles(scope: string | null) {
  mkdirSync(join(oauthRefreshPath(), ".."), { recursive: true });
  writeFileSync(oauthRefreshPath(), "rt");
  if (scope !== null) writeFileSync(oauthScopePath(), scope);
}

test("assertWriteAllowed passes when the recorded scope includes edit.containers", async () => {
  await withCache(() => writeTokenFiles(`${TAGMANAGER_READONLY_SCOPE} ${TAGMANAGER_EDIT_CONTAINERS_SCOPE}`),
    async () => { await assertWriteAllowed(); });
});
test("assertWriteAllowed rejects a read-only grant", async () => {
  await withCache(() => writeTokenFiles(TAGMANAGER_READONLY_SCOPE),
    async () => { await expect(assertWriteAllowed()).rejects.toThrow(/gallium login --write/); });
});
test("assertWriteAllowed rejects when there is no scope file", async () => {
  await withCache(() => writeTokenFiles(null),
    async () => { await expect(assertWriteAllowed()).rejects.toThrow(/gallium login --write/); });
});
test("assertWriteAllowed rejects when there is no OAuth refresh token", async () => {
  await withCache(null, async () => { await expect(assertWriteAllowed()).rejects.toThrow(/service account/i); });
});
