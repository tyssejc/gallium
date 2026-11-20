import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdLogin, runLogin } from "./auth.ts";
import { TAGMANAGER_READONLY_SCOPE, TAGMANAGER_EDIT_CONTAINERS_SCOPE } from "../auth/oauth.ts";
import { oauthScopePath, oauthRefreshPath } from "../auth/token.ts";
import { tokenCachePath } from "../paths.ts";

test("cmdLogin throws 'No [oauth] block' when config has no oauth block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-auth-"));
  const orig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    // configPath() => ${XDG_CONFIG_HOME}/gallium/config.toml
    const cfgDir = join(dir, "gallium");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.toml"), `[containers."x/y"]
account_id = "1"
container_id = "2"
workspace_id = "3"
`);
    await expect(cmdLogin([], {})).rejects.toThrow(/No \[oauth\] block/);
  } finally {
    if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withLoginEnv(fn: () => Promise<void>) {
  const cfg = mkdtempSync(join(tmpdir(), "gallium-auth-cfg-"));
  const cache = mkdtempSync(join(tmpdir(), "gallium-auth-cache-"));
  const origCfg = process.env.XDG_CONFIG_HOME, origCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CONFIG_HOME = cfg; process.env.XDG_CACHE_HOME = cache;
  mkdirSync(join(cfg, "gallium"), { recursive: true });
  writeFileSync(join(cfg, "gallium", "config.toml"), `[oauth]\nclient_id = "id"\nclient_secret = "secret"\n`);
  const log = console.log; console.log = () => {};
  try { await fn(); }
  finally {
    console.log = log;
    if (origCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origCfg;
    if (origCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = origCache;
    rmSync(cfg, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true });
  }
}
function stub() {
  const calls: string[][] = [];
  const loginOAuth = async (_id: string, _secret: string, scopes: string[]) => {
    calls.push(scopes); return { refreshToken: "rt", scope: scopes.join(" ") };
  };
  return { calls, loginOAuth };
}

test("login requests only the read-only scope", async () => {
  await withLoginEnv(async () => {
    const s = stub();
    expect(await runLogin({}, { loginOAuth: s.loginOAuth })).toBe(0);
    expect(s.calls).toEqual([[TAGMANAGER_READONLY_SCOPE]]);
  });
});

test("login --write requests read-only plus edit.containers and nothing else", async () => {
  await withLoginEnv(async () => {
    const s = stub();
    await runLogin({ write: true }, { loginOAuth: s.loginOAuth });
    expect(s.calls).toEqual([[TAGMANAGER_READONLY_SCOPE, TAGMANAGER_EDIT_CONTAINERS_SCOPE]]);
  });
});

test("login records the granted scope and deletes the cached access token", async () => {
  await withLoginEnv(async () => {
    const tok = tokenCachePath("oauth");
    mkdirSync(join(tok, ".."), { recursive: true });
    writeFileSync(tok, "{}");
    const s = stub();
    await runLogin({ write: true }, { loginOAuth: s.loginOAuth });
    expect(readFileSync(oauthScopePath(), "utf8")).toBe(`${TAGMANAGER_READONLY_SCOPE} ${TAGMANAGER_EDIT_CONTAINERS_SCOPE}`);
    expect(statSync(oauthScopePath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(oauthRefreshPath(), "utf8")).toBe("rt");
    expect(existsSync(tok)).toBe(false);
  });
});
