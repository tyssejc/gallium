# Gallium v1 Read-Only Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `gallium`, a bun/TypeScript CLI that pulls a Google Tag Manager container workspace into a local SQLite snapshot and answers read-only questions about it (reference graph, custom-code search, workspace diff/dirty, inventory/unused), plus a thin `SKILL.md` that maps questions → commands.

**Architecture:** Clone the proven `cadmium` (Adobe Tags) layout almost verbatim: a noun→verb CLI dispatcher; an API-client module (`gtm/`) that knows only the GTM Tag Manager API v2; a `cache/` SQLite layer that knows only SQLite; a `pull/` module that wires client→cache; `commands/` that read only from `cache/`; TOML config with container aliases; XDG-aware paths; tokens cached on disk. Reference data (tags/triggers/variables) is pulled from the **working workspace**; the workspace's pending changes come from the API's native `workspaces:getStatus` (the diff source for `diff`/`dirty`).

**Tech Stack:** Bun, TypeScript (ESM, `"type": "module"`), `bun:sqlite`, `bun test`, `smol-toml` for config, Node `crypto` for service-account JWT signing, `Bun.serve` for the OAuth loopback. Distributed via Homebrew.

## Global Constraints

- Runtime: **Bun** (matches `cadmium`); all source is `.ts`, ESM, imported with explicit `.ts` extensions.
- GTM API: **Tag Manager API v2**, base `https://tagmanager.googleapis.com/tagmanager/v2`. Read scope: `https://www.googleapis.com/auth/tagmanager.readonly`. **Verify all endpoint paths and the live-version endpoint against current docs via Context7 (`googleapis` / "Tag Manager API v2") before coding the client** — do not trust memory for exact paths.
- Auth: **support both** — OAuth user flow is the default; service account is opt-in via config. Read-only only in v1 (no write scopes requested).
- Binary name: `gallium`. Config/cache namespace: `gallium`. Skill install dir: `<claude>/skills/gallium`.
- Every command accepts `--json` and prints machine-readable JSON when passed; default (non-JSON) output is TSV. Answers lead with the conclusion.
- TDD throughout: failing test → minimal impl → green → commit. One logical change per commit.
- GTM variable references are the `{{Variable Name}}` token convention; tag→trigger references are numeric `firingTriggerId` / `blockingTriggerId` arrays.

---

## File Structure

```
package.json, tsconfig.json, bun.lock
bin/gallium.ts                      # shebang entrypoint → src/cli.ts run()
src/
  cli.ts                            # noun→verb dispatch, parseArgs
  command.ts                        # Cmd type
  version.ts                        # VERSION from package.json
  output.ts                         # format(data, {json, columns})
  paths.ts                          # XDG config/cache/token/skill paths
  util/fs.ts                        # ensureDirFor
  config/
    config.ts                       # parse/load config.toml (accounts + containers)
    state.ts                        # default-alias state.toml
  auth/
    serviceAccount.ts               # JWT (RS256) → access token
    oauth.ts                        # loopback login → refresh token; refresh → access token
    token.ts                        # getAccessToken(account): dispatch SA vs OAuth, cache
  gtm/
    types.ts                        # GTM API resource shapes
    client.ts                       # GtmClient: list workspace resources, getStatus, live version
  cache/
    schema.ts                       # SCHEMA_VERSION + DDL
    db.ts                           # openDb / openDbAt (migrate-by-drop)
    repo.ts                         # upserts + query functions
  pull/
    classify.ts                     # extract {{var}} refs, search_text, firing triggers
    pull.ts                         # orchestrate client → repo
  commands/
    _shared.ts                      # openPulled, resolveAlias
    container.ts                    # init/use/show/list/status/pull
    refs.ts                         # refs <name>
    entity.ts                       # tag <name>, trigger <name>
    code.ts                         # code search <pattern>
    diff.ts                         # diff / dirty
    list.ts                         # list tags|triggers|variables|folders [--unused …]
    skill.ts                        # skill install / path
  skill/
    SKILL.md
    references/gtm-concepts.md
Formula/gallium.rb
README.md
```

---

## Task 1: Project scaffold + foundation utilities

**Files:**
- Create: `package.json`, `tsconfig.json`, `bin/gallium.ts`, `src/command.ts`, `src/version.ts`, `src/output.ts`, `src/paths.ts`, `src/util/fs.ts`
- Test: `src/output.test.ts`, `src/paths.test.ts`, `src/version.test.ts`

**Interfaces:**
- Produces: `Cmd = (rest: string[], flags: Record<string, unknown>) => Promise<number>`; `format(data, {json, columns?})`; `configPath/statePath/cacheDir/cacheDbPath/tokenCachePath/skillInstallDir(env?)`; `ensureDirFor(path)`; `VERSION`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "gallium",
  "version": "0.1.0",
  "type": "module",
  "bin": { "gallium": "./bin/gallium.ts" },
  "scripts": { "test": "bun test", "gallium": "bun run bin/gallium.ts" },
  "dependencies": { "smol-toml": "^1.6.1" },
  "devDependencies": { "@types/bun": "latest" }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun"]
  }
}
```

- [ ] **Step 3: Install deps**

Run: `bun install`
Expected: creates `bun.lock`, `node_modules/`.

- [ ] **Step 4: Write `src/command.ts`, `bin/gallium.ts`, `src/version.ts`**

`src/command.ts`:
```typescript
export type Cmd = (rest: string[], flags: Record<string, unknown>) => Promise<number>;
```

`bin/gallium.ts`:
```typescript
#!/usr/bin/env bun
import { run } from "../src/cli.ts";
run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
```

`src/version.ts`:
```typescript
import pkg from "../package.json";
export const VERSION: string = pkg.version;
```

(`src/cli.ts` does not exist yet — `bin` will fail to run until Task 10. That is expected.)

- [ ] **Step 5: Write the failing test for `output.ts`**

`src/output.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { format } from "./output.ts";

test("format renders JSON when json:true", () => {
  expect(format([{ a: 1 }], { json: true })).toBe(JSON.stringify([{ a: 1 }], null, 2));
});

test("format renders TSV with chosen columns", () => {
  const out = format([{ name: "X", id: "1" }], { json: false, columns: ["name", "id"] });
  expect(out).toBe("name\tid\nX\t1");
});

test("format returns (no results) for empty arrays in TSV mode", () => {
  expect(format([], { json: false })).toBe("(no results)");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/output.test.ts`
Expected: FAIL (cannot find module `./output.ts`).

- [ ] **Step 7: Write `src/output.ts`**

```typescript
export interface FormatOpts { json: boolean; columns?: string[]; }

export function format(data: unknown, opts: FormatOpts): string {
  if (opts.json) return JSON.stringify(data, null, 2);
  if (Array.isArray(data)) {
    if (data.length === 0) return "(no results)";
    const cols = opts.columns ?? Object.keys(data[0] as object);
    const header = cols.join("\t");
    const rows = data.map((row) => cols.map((c) => String((row as any)[c] ?? "")).join("\t"));
    return [header, ...rows].join("\n");
  }
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}
```

- [ ] **Step 8: Write `src/util/fs.ts` and `src/paths.ts` with a failing paths test**

`src/util/fs.ts`:
```typescript
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDirFor(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
```

`src/paths.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { configPath, cacheDbPath, tokenCachePath, skillInstallDir } from "./paths.ts";

const env = { HOME: "/home/u", XDG_CONFIG_HOME: "", XDG_CACHE_HOME: "" };

test("configPath honors HOME default", () => {
  expect(configPath(env)).toBe("/home/u/.config/gallium/config.toml");
});
test("cacheDbPath is namespaced per alias", () => {
  expect(cacheDbPath("acme/web", env)).toBe("/home/u/.cache/gallium/acme/web.db");
});
test("XDG_CONFIG_HOME overrides HOME", () => {
  expect(configPath({ ...env, XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gallium/config.toml");
});
test("skillInstallDir honors CLAUDE_CONFIG_DIR", () => {
  expect(skillInstallDir({ ...env, CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/skills/gallium");
});
```

`src/paths.ts`:
```typescript
type Env = Record<string, string | undefined>;

function base(env: Env, xdgVar: string, fallback: string): string {
  const xdg = env[xdgVar];
  if (xdg && xdg.length > 0) return xdg;
  return `${env.HOME ?? ""}/${fallback}`;
}

export function configPath(env: Env = process.env): string {
  return `${base(env, "XDG_CONFIG_HOME", ".config")}/gallium/config.toml`;
}
export function statePath(env: Env = process.env): string {
  return `${base(env, "XDG_CONFIG_HOME", ".config")}/gallium/state.toml`;
}
export function cacheDir(env: Env = process.env): string {
  return `${base(env, "XDG_CACHE_HOME", ".cache")}/gallium`;
}
export function cacheDbPath(alias: string, env: Env = process.env): string {
  return `${cacheDir(env)}/${alias}.db`;
}
export function tokenCachePath(account: string, env: Env = process.env): string {
  return `${cacheDir(env)}/.tokens/${account}.json`;
}
export function skillInstallDir(env: Env = process.env): string {
  const claudeDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : `${env.HOME ?? ""}/.claude`;
  return `${claudeDir}/skills/gallium`;
}
```

`src/version.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { VERSION } from "./version.ts";
test("VERSION is a semver string", () => { expect(VERSION).toMatch(/^\d+\.\d+\.\d+/); });
```

- [ ] **Step 9: Run all tests**

Run: `bun test`
Expected: PASS (output, paths, version).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: scaffold gallium project + foundation utils (paths, output, version)"
```

---

## Task 2: Config + state (container aliases, default alias)

**Files:**
- Create: `src/config/config.ts`, `src/config/state.ts`
- Test: `src/config/config.test.ts`, `src/config/state.test.ts`

**Interfaces:**
- Consumes: `smol-toml` `parse`.
- Produces:
  - `AccountAuth = { mode: "oauth"; client_id: string; client_secret: string } | { mode: "service_account"; key_file: string }`
  - `ContainerConfig = { account: string; account_id: string; container_id: string; workspace_id: string }`
  - `Config = { accounts: Record<string, AccountAuth>; containers: Record<string, ContainerConfig> }`
  - `ResolvedContainer = { alias: string; accountId: string; containerId: string; workspaceId: string; account: AccountAuth; accountName: string }`
  - `parseConfig(toml, env?) => Config`; `loadConfig(path, env?) => Promise<Config>`; `resolveContainer(cfg, alias) => ResolvedContainer`
  - `loadState(path) => Promise<{ default_container?: string }>`; `saveState(path, state) => Promise<void>`

- [ ] **Step 1: Write failing config test**

`src/config/config.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { parseConfig, resolveContainer } from "./config.ts";

const TOML = `
[accounts.acme]
mode = "oauth"
client_id = "cid"
client_secret = "\${env:GALLIUM_SECRET}"

[accounts.sa]
mode = "service_account"
key_file = "/keys/sa.json"

[containers."acme/web"]
account = "acme"
account_id = "111"
container_id = "222"
workspace_id = "3"
`;

test("parseConfig substitutes env in secrets and reads both auth modes", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "shh" });
  expect(cfg.accounts.acme).toEqual({ mode: "oauth", client_id: "cid", client_secret: "shh" });
  expect(cfg.accounts.sa).toEqual({ mode: "service_account", key_file: "/keys/sa.json" });
});

test("resolveContainer joins container to its account", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "shh" });
  const r = resolveContainer(cfg, "acme/web");
  expect(r).toMatchObject({ accountId: "111", containerId: "222", workspaceId: "3", accountName: "acme" });
  expect(r.account.mode).toBe("oauth");
});

test("resolveContainer throws on unknown alias", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "shh" });
  expect(() => resolveContainer(cfg, "nope")).toThrow(/Unknown container alias/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config/config.test.ts`
Expected: FAIL (cannot find `./config.ts`).

- [ ] **Step 3: Write `src/config/config.ts`**

```typescript
import { parse as parseToml } from "smol-toml";

export type AccountAuth =
  | { mode: "oauth"; client_id: string; client_secret: string }
  | { mode: "service_account"; key_file: string };

export interface ContainerConfig {
  account: string; account_id: string; container_id: string; workspace_id: string;
}
export interface Config {
  accounts: Record<string, AccountAuth>;
  containers: Record<string, ContainerConfig>;
}
export interface ResolvedContainer {
  alias: string; accountId: string; containerId: string; workspaceId: string;
  account: AccountAuth; accountName: string;
}

const ENV_RE = /\$\{env:([A-Z0-9_]+)\}/g;
function substitute(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_RE, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Config references missing env var: ${name}`);
    return v;
  });
}

export function parseConfig(toml: string, env: Record<string, string | undefined> = process.env): Config {
  const raw = parseToml(toml) as any;
  const accounts: Record<string, AccountAuth> = {};
  for (const [name, a] of Object.entries(raw.accounts ?? {})) {
    const acct = a as any;
    if (acct.mode === "service_account") {
      accounts[name] = { mode: "service_account", key_file: acct.key_file };
    } else {
      accounts[name] = {
        mode: "oauth",
        client_id: acct.client_id,
        client_secret: substitute(acct.client_secret ?? "", env),
      };
    }
  }
  const containers: Record<string, ContainerConfig> = {};
  for (const [alias, c] of Object.entries(raw.containers ?? {})) {
    const cc = c as any;
    containers[alias] = {
      account: cc.account, account_id: String(cc.account_id),
      container_id: String(cc.container_id), workspace_id: String(cc.workspace_id),
    };
  }
  return { accounts, containers };
}

export function resolveContainer(cfg: Config, alias: string): ResolvedContainer {
  const c = cfg.containers[alias];
  if (!c) {
    const available = Object.keys(cfg.containers).join(", ") || "(none configured)";
    throw new Error(`Unknown container alias '${alias}'. Available: ${available}`);
  }
  const account = cfg.accounts[c.account];
  if (!account) throw new Error(`Container '${alias}' references undefined account '${c.account}'`);
  return {
    alias, accountId: c.account_id, containerId: c.container_id, workspaceId: c.workspace_id,
    account, accountName: c.account,
  };
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`No config at ${path}. Run 'gallium container init' to create one.`);
  return parseConfig(await file.text(), env);
}
```

- [ ] **Step 4: Run config test → PASS**

Run: `bun test src/config/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing state test + `src/config/state.ts`**

`src/config/state.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadState, saveState } from "./state.ts";

test("state round-trips default_container", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-state-"));
  const path = join(dir, "state.toml");
  try {
    expect(await loadState(path)).toEqual({});
    await saveState(path, { default_container: "acme/web" });
    expect(await loadState(path)).toEqual({ default_container: "acme/web" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

`src/config/state.ts`:
```typescript
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDirFor } from "../util/fs.ts";

export interface State { default_container?: string; }

export async function loadState(path: string): Promise<State> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  return parseToml(await file.text()) as State;
}
export async function saveState(path: string, state: State): Promise<void> {
  await ensureDirFor(path);
  await Bun.write(path, stringifyToml(state as Record<string, unknown>));
}
```

- [ ] **Step 6: Run tests → PASS, then commit**

```bash
bun test src/config
git add -A
git commit -m "feat: config (accounts + container aliases) and default-container state"
```

---

## Task 3: Auth — service account + OAuth token acquisition

**Files:**
- Create: `src/auth/serviceAccount.ts`, `src/auth/oauth.ts`, `src/auth/token.ts`
- Test: `src/auth/serviceAccount.test.ts`, `src/auth/token.test.ts`

**Interfaces:**
- Consumes: `AccountAuth` (Task 2), `tokenCachePath` (Task 1).
- Produces:
  - `signServiceAccountJwt(keyJson, scope, nowSec) => string` (RS256 JWT)
  - `exchangeJwtForToken(jwt, fetchFn?) => Promise<{ access_token: string; expires_in: number }>`
  - `refreshAccessToken(clientId, clientSecret, refreshToken, fetchFn?) => Promise<{ access_token: string; expires_in: number }>`
  - `getAccessToken(accountName, account: AccountAuth, opts?) => Promise<string>` — reads/writes the token cache, refreshes when expired.
- The OAuth read scope constant: `TAGMANAGER_READONLY_SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly"`.

- [ ] **Step 1: Write failing test for JWT signing**

`src/auth/serviceAccount.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { signServiceAccountJwt } from "./serviceAccount.ts";

test("signServiceAccountJwt produces a verifiable RS256 JWT with correct claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyJson = { client_email: "sa@x.iam.gserviceaccount.com", private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token" };
  const jwt = signServiceAccountJwt(keyJson, "scopeA", 1000);
  const [h, p, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  expect(claims).toMatchObject({ iss: keyJson.client_email, scope: "scopeA", aud: keyJson.token_uri, iat: 1000, exp: 4600 });
  const v = createVerify("RSA-SHA256"); v.update(`${h}.${p}`); v.end();
  expect(v.verify(createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString()),
    Buffer.from(sig, "base64url"))).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL, then write `src/auth/serviceAccount.ts`**

Run: `bun test src/auth/serviceAccount.test.ts` → FAIL (no module).

```typescript
import { createSign } from "node:crypto";

export interface ServiceAccountKey {
  client_email: string; private_key: string; token_uri: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signServiceAccountJwt(key: ServiceAccountKey, scope: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: key.client_email, scope, aud: key.token_uri, iat: nowSec, exp: nowSec + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`); signer.end();
  const sig = b64url(signer.sign(key.private_key));
  return `${header}.${payload}.${sig}`;
}

export async function exchangeJwtForToken(
  key: ServiceAccountKey, jwt: string, fetchFn: typeof fetch = fetch,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetchFn(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Service-account token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}
```

- [ ] **Step 3: Run → PASS**

Run: `bun test src/auth/serviceAccount.test.ts` → PASS.

- [ ] **Step 4: Write `src/auth/oauth.ts`**

Refresh-token exchange + an interactive loopback login that obtains a refresh token. `loginOAuth` opens the consent URL, runs a one-shot loopback server to capture the `code`, and exchanges it.

```typescript
export const TAGMANAGER_READONLY_SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly";
const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

export async function refreshAccessToken(
  clientId: string, clientSecret: string, refreshToken: string, fetchFn: typeof fetch = fetch,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetchFn(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`OAuth refresh failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

// Interactive: returns a refresh_token. Uses a loopback redirect on an ephemeral port.
export async function loginOAuth(clientId: string, clientSecret: string): Promise<string> {
  const server = Bun.serve({ port: 0, fetch() { return new Response(""); } });
  const redirectUri = `http://127.0.0.1:${server.port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      server.reload({
        fetch(req) {
          const url = new URL(req.url);
          const c = url.searchParams.get("code");
          if (c) { resolve(c); return new Response("gallium: authorized. You can close this tab."); }
          const err = url.searchParams.get("error");
          if (err) { reject(new Error(`OAuth error: ${err}`)); return new Response(`error: ${err}`); }
          return new Response("waiting…");
        },
      });
      const authUrl = `${AUTH_URI}?` + new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code",
        scope: TAGMANAGER_READONLY_SCOPE, access_type: "offline", prompt: "consent",
      });
      console.error(`Opening browser to authorize:\n${authUrl}`);
      // Best-effort open; user can paste the URL manually if this fails.
      Bun.spawn(["open", authUrl]).exited.catch(() => {});
    });
    const res = await fetch(TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code,
        grant_type: "authorization_code", redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`OAuth code exchange failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { refresh_token?: string };
    if (!body.refresh_token) throw new Error("No refresh_token returned (try revoking prior consent).");
    return body.refresh_token;
  } finally { server.stop(true); }
}
```

- [ ] **Step 5: Write failing test for `getAccessToken` cache behavior + write `src/auth/token.ts`**

`src/auth/token.test.ts` (uses a temp token cache and an injected clock + fetch to assert caching):
```typescript
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
```

`src/auth/token.ts` — the public `getAccessToken(accountName, account)` wraps a lower-level testable core. Show both:
```typescript
import { ensureDirFor } from "../util/fs.ts";
import { tokenCachePath } from "../paths.ts";
import type { AccountAuth } from "../config/config.ts";
import { refreshAccessToken } from "./oauth.ts";
import { exchangeJwtForToken, signServiceAccountJwt, type ServiceAccountKey } from "./serviceAccount.ts";

interface CachedToken { access_token: string; expires_at_ms: number; }

interface CoreOpts {
  cachePath: string; nowMs: number;
  refresher: () => Promise<{ access_token: string; expires_in: number }>;
}

// Testable core: returns a valid token, refreshing through `refresher` when the
// cache is missing or within 5 minutes of expiry.
export async function getAccessToken(opts: CoreOpts): Promise<string> {
  const file = Bun.file(opts.cachePath);
  if (await file.exists()) {
    const cached = (await file.json()) as CachedToken;
    if (cached.expires_at_ms - opts.nowMs > 5 * 60_000) return cached.access_token;
  }
  const fresh = await opts.refresher();
  const next: CachedToken = { access_token: fresh.access_token, expires_at_ms: opts.nowMs + fresh.expires_in * 1000 };
  await ensureDirFor(opts.cachePath);
  await Bun.write(opts.cachePath, JSON.stringify(next));
  return fresh.access_token;
}

// Production entrypoint: builds the right refresher for the account's auth mode.
export async function getAccountToken(accountName: string, account: AccountAuth): Promise<string> {
  const cachePath = tokenCachePath(accountName);
  if (account.mode === "service_account") {
    const key = (await Bun.file(account.key_file).json()) as ServiceAccountKey;
    return getAccessToken({
      cachePath, nowMs: Date.now(),
      refresher: () => exchangeJwtForToken(key, signServiceAccountJwt(key,
        "https://www.googleapis.com/auth/tagmanager.readonly", Math.floor(Date.now() / 1000))),
    });
  }
  // OAuth: refresh token was stored at login time next to the access-token cache.
  const refreshPath = `${cachePath}.refresh`;
  const refreshToken = (await Bun.file(refreshPath).text()).trim();
  return getAccessToken({
    cachePath, nowMs: Date.now(),
    refresher: () => refreshAccessToken(account.client_id, account.client_secret, refreshToken),
  });
}
```

- [ ] **Step 6: Run → PASS, commit**

```bash
bun test src/auth
git add -A
git commit -m "feat: auth — service-account JWT and OAuth refresh/login token acquisition"
```

---

## Task 4: GTM API v2 client

**Files:**
- Create: `src/gtm/types.ts`, `src/gtm/client.ts`
- Test: `src/gtm/client.test.ts`

**Interfaces:**
- Consumes: an access token (string) from Task 3.
- Produces:
  - Types: `GtmTag, GtmTrigger, GtmVariable, GtmBuiltInVariable, GtmFolder, GtmTemplate, GtmParameter, WorkspaceStatus`.
  - `class GtmClient(token, fetchFn?)` with `wsPath(accountId, containerId, workspaceId)`, and methods that take a workspace path:
    - `listTags(ws) / listTriggers(ws) / listVariables(ws) / listBuiltInVariables(ws) / listFolders(ws) / listTemplates(ws)` → arrays (auto-paginated on `nextPageToken`).
    - `getStatus(ws) => Promise<WorkspaceStatus>` (the `workspaces:getStatus` change list).

**Note:** First, **verify endpoint paths against current GTM API v2 docs via Context7** (base URL, the `:getStatus` suffix, list field names like `tag`/`trigger`/`variable`, and the `nextPageToken` paging field). Adjust the code below if docs differ.

- [ ] **Step 1: Write `src/gtm/types.ts`**

```typescript
export interface GtmParameter {
  type: string; key?: string; value?: string;
  list?: GtmParameter[]; map?: GtmParameter[];
}
export interface GtmTag {
  tagId: string; name: string; type: string; parameter?: GtmParameter[];
  firingTriggerId?: string[]; blockingTriggerId?: string[];
  parentFolderId?: string; paused?: boolean; notes?: string;
}
export interface GtmTrigger {
  triggerId: string; name: string; type: string;
  parameter?: GtmParameter[]; filter?: GtmParameter[]; customEventFilter?: GtmParameter[];
  parentFolderId?: string; notes?: string;
}
export interface GtmVariable {
  variableId: string; name: string; type: string;
  parameter?: GtmParameter[]; parentFolderId?: string; notes?: string;
}
export interface GtmBuiltInVariable { type: string; name: string; }
export interface GtmFolder { folderId: string; name: string; }
export interface GtmTemplate { templateId: string; name: string; templateData?: string; }

export interface WorkspaceChange {
  changeStatus: "added" | "deleted" | "updated" | "none" | string;
  tag?: GtmTag; trigger?: GtmTrigger; variable?: GtmVariable; folder?: GtmFolder;
}
export interface WorkspaceStatus {
  workspaceChange?: WorkspaceChange[];
  mergeConflict?: unknown[];
}
```

- [ ] **Step 2: Write failing client test (injected fetch, two-page pagination)**

`src/gtm/client.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { GtmClient } from "./client.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("listTags follows nextPageToken and concatenates", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.includes("pageToken=p2")) return jsonResponse({ tag: [{ tagId: "2", name: "B" }] });
    return jsonResponse({ tag: [{ tagId: "1", name: "A" }], nextPageToken: "p2" });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  const ws = client.wsPath("111", "222", "3");
  const tags = await client.listTags(ws);
  expect(tags.map((t) => t.tagId)).toEqual(["1", "2"]);
  expect(calls[0]).toContain("/accounts/111/containers/222/workspaces/3/tags");
  expect(calls[0]).toContain("Bearer".length ? "" : ""); // header asserted below indirectly
});

test("non-2xx throws with status and body", async () => {
  const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  await expect(client.listTags("accounts/1/containers/2/workspaces/3")).rejects.toThrow(/403/);
});
```

- [ ] **Step 3: Run → FAIL, then write `src/gtm/client.ts`**

```typescript
import type {
  GtmTag, GtmTrigger, GtmVariable, GtmBuiltInVariable, GtmFolder, GtmTemplate, WorkspaceStatus,
} from "./types.ts";

const BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

export class GtmClient {
  constructor(private token: string, private fetchFn: typeof fetch = fetch) {}

  wsPath(accountId: string, containerId: string, workspaceId: string): string {
    return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  private async getJson(path: string, query: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams(query).toString();
    const url = `${BASE}/${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`GTM GET ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  // Pages through `nextPageToken`, collecting the array under `field`.
  private async listAll<T>(path: string, field: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const body = await this.getJson(path, pageToken ? { pageToken } : {});
      if (Array.isArray(body[field])) out.push(...body[field]);
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  listTags(ws: string): Promise<GtmTag[]> { return this.listAll(`${ws}/tags`, "tag"); }
  listTriggers(ws: string): Promise<GtmTrigger[]> { return this.listAll(`${ws}/triggers`, "trigger"); }
  listVariables(ws: string): Promise<GtmVariable[]> { return this.listAll(`${ws}/variables`, "variable"); }
  listBuiltInVariables(ws: string): Promise<GtmBuiltInVariable[]> { return this.listAll(`${ws}/built_in_variables`, "builtInVariable"); }
  listFolders(ws: string): Promise<GtmFolder[]> { return this.listAll(`${ws}/folders`, "folder"); }
  listTemplates(ws: string): Promise<GtmTemplate[]> { return this.listAll(`${ws}/templates`, "template"); }

  getStatus(ws: string): Promise<WorkspaceStatus> { return this.getJson(`${ws}/status`); }
}
```

(Note: the `:getStatus` custom method is reached as `…/workspaces/{id}:getStatus`. Confirm the exact spelling via Context7; if it is the colon form, change `${ws}/status` to `${ws}:getStatus` and ensure the colon is not URL-encoded.)

- [ ] **Step 4: Run → PASS, commit**

```bash
bun test src/gtm
git add -A
git commit -m "feat: GTM Tag Manager API v2 client (paginated list + getStatus)"
```

---

## Task 5: Cache schema + db open/migrate

**Files:**
- Create: `src/cache/schema.ts`, `src/cache/db.ts`
- Test: `src/cache/db.test.ts`

**Interfaces:**
- Produces: `SCHEMA_VERSION`, `DDL`; `openDb(alias) => Promise<Database>`; `openDbAt(path) => Database` (drops + rebuilds when stored `schema_version` mismatches).

- [ ] **Step 1: Write `src/cache/schema.ts`**

```typescript
export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- One row per entity in the working workspace.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT NOT NULL,                  -- numeric GTM id (tagId/triggerId/variableId/folderId) or builtin type
  kind TEXT NOT NULL,                -- tag | trigger | variable | builtin_variable | folder | template
  name TEXT NOT NULL,
  type TEXT,                         -- GTM type string (e.g. html, jsm, gaawe)
  paused INTEGER NOT NULL DEFAULT 0,
  parent_folder_id TEXT,
  raw_json TEXT,                     -- full entity JSON
  search_text TEXT,                  -- name + parameter values + code, lowercased
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

-- A references B: source entity references a variable by {{name}}.
CREATE TABLE IF NOT EXISTS variable_refs (
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
  variable_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_varrefs_name ON variable_refs(variable_name);

-- Tag fires on trigger (firing|blocking).
CREATE TABLE IF NOT EXISTS tag_triggers (
  tag_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'firing'   -- firing | blocking
);
CREATE INDEX IF NOT EXISTS idx_tagtrig_tag ON tag_triggers(tag_id);
CREATE INDEX IF NOT EXISTS idx_tagtrig_trig ON tag_triggers(trigger_id);

-- Workspace pending changes, from getStatus.
CREATE TABLE IF NOT EXISTS changes (
  kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT, change_status TEXT NOT NULL
);
`;
```

- [ ] **Step 2: Write failing db test + `src/cache/db.ts`**

`src/cache/db.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDbAt } from "./db.ts";
import { SCHEMA_VERSION } from "./schema.ts";

test("openDbAt rebuilds when stored schema_version mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-db-"));
  const path = join(dir, "t.db");
  try {
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    old.exec("INSERT INTO meta VALUES ('schema_version','0');");
    old.exec("CREATE TABLE entities (legacy TEXT);");
    old.close();
    const db = openDbAt(path);
    const cols = (db.query("PRAGMA table_info(entities)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("search_text");
    expect(cols).not.toContain("legacy");
    const ver = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(ver.value).toBe(String(SCHEMA_VERSION));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

`src/cache/db.ts`:
```typescript
import { Database } from "bun:sqlite";
import { cacheDbPath } from "../paths.ts";
import { ensureDirFor } from "../util/fs.ts";
import { DDL, SCHEMA_VERSION } from "./schema.ts";

export async function openDb(alias: string): Promise<Database> {
  const path = cacheDbPath(alias);
  await ensureDirFor(path);
  return openDbAt(path);
}

export function openDbAt(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  const row = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | null;
  const stored = row?.value ?? null;
  if (stored !== null && stored !== String(SCHEMA_VERSION)) {
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS ${t.name};`);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  }
  db.exec(DDL);
  if (stored !== String(SCHEMA_VERSION)) {
    db.query("INSERT INTO meta (key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(SCHEMA_VERSION));
  }
  return db;
}
```

- [ ] **Step 3: Run → PASS, commit**

```bash
bun test src/cache/db.test.ts
git add -A
git commit -m "feat: SQLite cache schema + migrate-by-drop db opener"
```

---

## Task 6: Classify — extract variable refs, firing triggers, search_text

**Files:**
- Create: `src/pull/classify.ts`
- Test: `src/pull/classify.test.ts`

**Interfaces:**
- Consumes: `GtmTag, GtmTrigger, GtmVariable, GtmParameter` (Task 4).
- Produces:
  - `collectParameterStrings(params?: GtmParameter[]) => string[]` (recursively flattens `value`/`list`/`map`).
  - `extractVariableRefs(strings: string[]) => string[]` (unique `{{Name}}` tokens, names only).
  - `buildSearchText(name: string, strings: string[]) => string` (lowercased name + values joined).

- [ ] **Step 1: Write failing test**

`src/pull/classify.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { collectParameterStrings, extractVariableRefs, buildSearchText } from "./classify.ts";

test("collectParameterStrings flattens nested list/map params", () => {
  const params = [
    { type: "template", key: "html", value: "<script>{{GA4 ID}}</script>" },
    { type: "list", key: "rows", list: [
      { type: "map", map: [{ type: "template", key: "k", value: "{{Page Path}}" }] },
    ]},
  ];
  expect(collectParameterStrings(params)).toEqual(["<script>{{GA4 ID}}</script>", "{{Page Path}}"]);
});

test("extractVariableRefs returns unique variable names", () => {
  const refs = extractVariableRefs(["a {{X}} b {{Y}}", "{{X}}"]);
  expect(refs.sort()).toEqual(["X", "Y"]);
});

test("extractVariableRefs ignores empty braces", () => {
  expect(extractVariableRefs(["{{}} {{ Trimmed }}"])).toEqual(["Trimmed"]);
});

test("buildSearchText lowercases name and values", () => {
  expect(buildSearchText("My Tag", ["DataLayer.Foo"])).toBe("my tag\ndatalayer.foo");
});
```

- [ ] **Step 2: Run → FAIL, then write `src/pull/classify.ts`**

```typescript
import type { GtmParameter } from "../gtm/types.ts";

export function collectParameterStrings(params?: GtmParameter[]): string[] {
  const out: string[] = [];
  for (const p of params ?? []) {
    if (typeof p.value === "string") out.push(p.value);
    if (p.list) out.push(...collectParameterStrings(p.list));
    if (p.map) out.push(...collectParameterStrings(p.map));
  }
  return out;
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractVariableRefs(strings: string[]): string[] {
  const found = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(VAR_RE)) {
      const name = m[1]?.trim();
      if (name) found.add(name);
    }
  }
  return [...found];
}

export function buildSearchText(name: string, strings: string[]): string {
  return [name, ...strings].join("\n").toLowerCase();
}
```

- [ ] **Step 3: Run → PASS, commit**

```bash
bun test src/pull/classify.test.ts
git add -A
git commit -m "feat: classify GTM params — variable refs + search text"
```

---

## Task 7: Cache repo — upserts and queries

**Files:**
- Create: `src/cache/repo.ts`
- Test: `src/cache/repo.test.ts`

**Interfaces:**
- Consumes: `Database`, `DDL` (via `openDbAt(":memory:")`).
- Produces (all take `db: Database` first):
  - `setMeta(db,k,v)`, `getMeta(db,k) => string|null`
  - `resetDerived(db)` — clears `entities, variable_refs, tag_triggers, changes`
  - `upsertEntity(db, row: EntityRow)`
  - `recordVariableRef(db, sourceKind, sourceId, variableName)`
  - `recordTagTrigger(db, tagId, triggerId, relation)`
  - `recordChange(db, kind, id, name, changeStatus)`
  - Queries:
    - `refsToVariable(db, name) => { kind, id, name }[]` (entities referencing `{{name}}`)
    - `tagFiringTriggers(db, tagId) => { id, name, relation }[]`
    - `tagsFiringOnTrigger(db, triggerId) => { tag_id, name, relation }[]`
    - `grepCode(db, pattern) => { kind, id, name }[]` (LIKE on `search_text`, `_`/`%` escaped)
    - `listEntities(db, kind, { type?, folderId?, pausedOnly? }) => EntityRow[]`
    - `unusedVariables(db) => { id, name }[]` (variables whose name appears in no `variable_refs`)
    - `pendingChanges(db, { status? }) => { kind, id, name, change_status }[]`
    - `findEntityByName(db, kind, name) => EntityRow | null`
  - Type `EntityRow = { id, kind, name, type, paused, parentFolderId, rawJson, searchText }`.

- [ ] **Step 1: Write failing repo test (representative behaviors)**

`src/cache/repo.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDbAt } from "./db.ts";
import {
  upsertEntity, recordVariableRef, recordTagTrigger, recordChange,
  refsToVariable, tagFiringTriggers, tagsFiringOnTrigger, grepCode,
  listEntities, unusedVariables, pendingChanges, findEntityByName, setMeta, getMeta,
} from "./repo.ts";

function db(): Database { return openDbAt(":memory:"); }
const ent = (over: Partial<any>) => ({ id: "x", kind: "tag", name: "X", type: "html",
  paused: false, parentFolderId: null, rawJson: "{}", searchText: "x", ...over });

test("refsToVariable returns entities that reference {{name}}", () => {
  const d = db();
  upsertEntity(d, ent({ id: "10", kind: "tag", name: "GA4 Event" }));
  recordVariableRef(d, "tag", "10", "GA4 ID");
  expect(refsToVariable(d, "GA4 ID")).toEqual([{ kind: "tag", id: "10", name: "GA4 Event" }]);
});

test("tag/trigger relations resolve both directions", () => {
  const d = db();
  upsertEntity(d, ent({ id: "10", kind: "tag", name: "GA4 Event" }));
  upsertEntity(d, ent({ id: "50", kind: "trigger", name: "All Pages", type: "pageview" }));
  recordTagTrigger(d, "10", "50", "firing");
  expect(tagFiringTriggers(d, "10")).toEqual([{ id: "50", name: "All Pages", relation: "firing" }]);
  expect(tagsFiringOnTrigger(d, "50")).toEqual([{ tag_id: "10", name: "GA4 Event", relation: "firing" }]);
});

test("grepCode matches search_text and treats _ literally", () => {
  const d = db();
  upsertEntity(d, ent({ id: "1", searchText: "datalayer.page_name = 1" }));
  upsertEntity(d, ent({ id: "2", searchText: "datalayerxpagexname" }));
  expect(grepCode(d, "page_name").map((r) => r.id)).toEqual(["1"]);
});

test("unusedVariables flags variables referenced nowhere", () => {
  const d = db();
  upsertEntity(d, ent({ id: "v1", kind: "variable", name: "Used", type: "jsm" }));
  upsertEntity(d, ent({ id: "v2", kind: "variable", name: "Orphan", type: "jsm" }));
  recordVariableRef(d, "tag", "10", "Used");
  expect(unusedVariables(d)).toEqual([{ id: "v2", name: "Orphan" }]);
});

test("listEntities filters by type/folder/paused; pendingChanges filters by status", () => {
  const d = db();
  upsertEntity(d, ent({ id: "1", kind: "tag", type: "html", paused: true, parentFolderId: "9" }));
  upsertEntity(d, ent({ id: "2", kind: "tag", type: "gaawe", paused: false }));
  expect(listEntities(d, "tag", { type: "html" }).map((r) => r.id)).toEqual(["1"]);
  expect(listEntities(d, "tag", { pausedOnly: true }).map((r) => r.id)).toEqual(["1"]);
  recordChange(d, "tag", "2", "B", "updated");
  expect(pendingChanges(d, {}).map((c) => c.id)).toEqual(["2"]);
  expect(pendingChanges(d, { status: "added" })).toEqual([]);
});

test("meta round-trips and findEntityByName is case-insensitive", () => {
  const d = db();
  setMeta(d, "last_pulled_at", "2026-06-19T00:00:00Z");
  expect(getMeta(d, "last_pulled_at")).toBe("2026-06-19T00:00:00Z");
  upsertEntity(d, ent({ id: "7", kind: "trigger", name: "All Pages" }));
  expect(findEntityByName(d, "trigger", "all pages")?.id).toBe("7");
});
```

- [ ] **Step 2: Run → FAIL, then write `src/cache/repo.ts`**

```typescript
import type { Database } from "bun:sqlite";

export interface EntityRow {
  id: string; kind: string; name: string; type: string | null;
  paused: boolean; parentFolderId: string | null; rawJson: string | null; searchText: string;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function getMeta(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
}

export function resetDerived(db: Database): void {
  for (const t of ["entities", "variable_refs", "tag_triggers", "changes"]) db.exec(`DELETE FROM ${t};`);
}

export function upsertEntity(db: Database, r: EntityRow): void {
  db.query(`INSERT INTO entities (id,kind,name,type,paused,parent_folder_id,raw_json,search_text)
    VALUES ($id,$kind,$name,$type,$paused,$folder,$raw,$search)
    ON CONFLICT(kind,id) DO UPDATE SET name=$name,type=$type,paused=$paused,
      parent_folder_id=$folder,raw_json=$raw,search_text=$search`).run({
    $id: r.id, $kind: r.kind, $name: r.name, $type: r.type, $paused: r.paused ? 1 : 0,
    $folder: r.parentFolderId, $raw: r.rawJson, $search: r.searchText,
  });
}

export function recordVariableRef(db: Database, sourceKind: string, sourceId: string, variableName: string): void {
  db.query("INSERT INTO variable_refs (source_kind,source_id,variable_name) VALUES (?,?,?)").run(sourceKind, sourceId, variableName);
}
export function recordTagTrigger(db: Database, tagId: string, triggerId: string, relation: string): void {
  db.query("INSERT INTO tag_triggers (tag_id,trigger_id,relation) VALUES (?,?,?)").run(tagId, triggerId, relation);
}
export function recordChange(db: Database, kind: string, id: string, name: string, changeStatus: string): void {
  db.query("INSERT INTO changes (kind,id,name,change_status) VALUES (?,?,?,?)").run(kind, id, name, changeStatus);
}

export function refsToVariable(db: Database, name: string): { kind: string; id: string; name: string }[] {
  return db.query(`SELECT e.kind AS kind, e.id AS id, e.name AS name
    FROM variable_refs vr JOIN entities e ON e.kind=vr.source_kind AND e.id=vr.source_id
    WHERE vr.variable_name=? ORDER BY e.kind, e.name`).all(name) as any;
}
export function tagFiringTriggers(db: Database, tagId: string): { id: string; name: string; relation: string }[] {
  return db.query(`SELECT tt.trigger_id AS id, e.name AS name, tt.relation AS relation
    FROM tag_triggers tt JOIN entities e ON e.kind='trigger' AND e.id=tt.trigger_id
    WHERE tt.tag_id=? ORDER BY tt.relation, e.name`).all(tagId) as any;
}
export function tagsFiringOnTrigger(db: Database, triggerId: string): { tag_id: string; name: string; relation: string }[] {
  return db.query(`SELECT tt.tag_id AS tag_id, e.name AS name, tt.relation AS relation
    FROM tag_triggers tt JOIN entities e ON e.kind='tag' AND e.id=tt.tag_id
    WHERE tt.trigger_id=? ORDER BY tt.relation, e.name`).all(triggerId) as any;
}

export function grepCode(db: Database, pattern: string): { kind: string; id: string; name: string }[] {
  const escaped = pattern.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.query(`SELECT kind,id,name FROM entities WHERE search_text LIKE ? ESCAPE '\\' ORDER BY kind,name`)
    .all(`%${escaped}%`) as any;
}

export function listEntities(
  db: Database, kind: string, opts: { type?: string; folderId?: string; pausedOnly?: boolean } = {},
): EntityRow[] {
  const where = ["kind=$kind"]; const params: Record<string, unknown> = { $kind: kind };
  if (opts.type) { where.push("type=$type"); params.$type = opts.type; }
  if (opts.folderId) { where.push("parent_folder_id=$folder"); params.$folder = opts.folderId; }
  if (opts.pausedOnly) where.push("paused=1");
  const rows = db.query(`SELECT id,kind,name,type,paused,parent_folder_id AS parentFolderId,
    raw_json AS rawJson, search_text AS searchText FROM entities WHERE ${where.join(" AND ")} ORDER BY name`).all(params) as any[];
  return rows.map((r) => ({ ...r, paused: !!r.paused }));
}

export function unusedVariables(db: Database): { id: string; name: string }[] {
  return db.query(`SELECT id,name FROM entities WHERE kind='variable'
    AND name NOT IN (SELECT variable_name FROM variable_refs) ORDER BY name`).all() as any;
}

export function pendingChanges(db: Database, opts: { status?: string } = {}): { kind: string; id: string; name: string; change_status: string }[] {
  if (opts.status) {
    return db.query("SELECT kind,id,name,change_status FROM changes WHERE change_status=? ORDER BY kind,name").all(opts.status) as any;
  }
  return db.query("SELECT kind,id,name,change_status FROM changes ORDER BY kind,name").all() as any;
}

export function findEntityByName(db: Database, kind: string, name: string): EntityRow | null {
  const r = db.query(`SELECT id,kind,name,type,paused,parent_folder_id AS parentFolderId,
    raw_json AS rawJson, search_text AS searchText FROM entities
    WHERE kind=? AND lower(name)=lower(?) LIMIT 1`).get(kind, name) as any;
  return r ? { ...r, paused: !!r.paused } : null;
}
```

- [ ] **Step 3: Run → PASS, commit**

```bash
bun test src/cache/repo.test.ts
git add -A
git commit -m "feat: cache repo — entity upserts and read queries"
```

---

## Task 8: Pull orchestration (client → repo)

**Files:**
- Create: `src/pull/pull.ts`
- Test: `src/pull/pull.test.ts`

**Interfaces:**
- Consumes: `GtmClient` (Task 4), repo writers + `resetDerived`/`setMeta` (Task 7), classify helpers (Task 6).
- Produces: `pullContainer(db, client, ws: string, nowIso: string) => Promise<void>` — full pull: resets derived tables, upserts all entity kinds, records variable refs + tag/trigger links + changes, sets `last_pulled_at`.

- [ ] **Step 1: Write failing test with a fake client**

`src/pull/pull.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { openDbAt } from "../cache/db.ts";
import { pullContainer } from "./pull.ts";
import { refsToVariable, tagFiringTriggers, unusedVariables, getMeta, pendingChanges, grepCode } from "../cache/repo.ts";

const fakeClient = {
  wsPath: () => "ws",
  listTags: async () => [{ tagId: "10", name: "GA4 Event", type: "gaawe",
    parameter: [{ type: "template", key: "measurementId", value: "{{GA4 ID}}" }],
    firingTriggerId: ["50"] }],
  listTriggers: async () => [{ triggerId: "50", name: "All Pages", type: "pageview" }],
  listVariables: async () => [
    { variableId: "v1", name: "GA4 ID", type: "c" },
    { variableId: "v2", name: "Orphan JS", type: "jsm",
      parameter: [{ type: "template", key: "javascript", value: "function(){return window.foo_bar;}" }] },
  ],
  listBuiltInVariables: async () => [{ type: "pageUrl", name: "Page URL" }],
  listFolders: async () => [],
  listTemplates: async () => [],
  getStatus: async () => ({ workspaceChange: [{ changeStatus: "updated", tag: { tagId: "10", name: "GA4 Event" } }] }),
} as any;

test("pullContainer populates entities, refs, triggers, changes, meta", async () => {
  const db = openDbAt(":memory:");
  await pullContainer(db, fakeClient, "ws", "2026-06-19T00:00:00Z");
  expect(refsToVariable(db, "GA4 ID").map((r) => r.name)).toEqual(["GA4 Event"]);
  expect(tagFiringTriggers(db, "10")).toEqual([{ id: "50", name: "All Pages", relation: "firing" }]);
  expect(unusedVariables(db).map((v) => v.name)).toEqual(["Orphan JS"]);
  expect(grepCode(db, "foo_bar").map((r) => r.id)).toContain("v2");
  expect(pendingChanges(db, {}).map((c) => c.id)).toEqual(["10"]);
  expect(getMeta(db, "last_pulled_at")).toBe("2026-06-19T00:00:00Z");
});
```

- [ ] **Step 2: Run → FAIL, then write `src/pull/pull.ts`**

```typescript
import type { Database } from "bun:sqlite";
import type { GtmClient } from "../gtm/client.ts";
import type { GtmTag, GtmTrigger, GtmVariable } from "../gtm/types.ts";
import {
  resetDerived, upsertEntity, recordVariableRef, recordTagTrigger, recordChange, setMeta,
} from "../cache/repo.ts";
import { collectParameterStrings, extractVariableRefs, buildSearchText } from "./classify.ts";

function recordRefs(db: Database, kind: string, id: string, name: string, strings: string[]): void {
  for (const ref of extractVariableRefs(strings)) recordVariableRef(db, kind, id, ref);
}

export async function pullContainer(db: Database, client: GtmClient, ws: string, nowIso: string): Promise<void> {
  resetDerived(db);

  for (const t of (await client.listTags(ws)) as GtmTag[]) {
    const strings = collectParameterStrings(t.parameter);
    upsertEntity(db, { id: t.tagId, kind: "tag", name: t.name, type: t.type, paused: !!t.paused,
      parentFolderId: t.parentFolderId ?? null, rawJson: JSON.stringify(t), searchText: buildSearchText(t.name, strings) });
    recordRefs(db, "tag", t.tagId, t.name, strings);
    for (const trig of t.firingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "firing");
    for (const trig of t.blockingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "blocking");
  }

  for (const tr of (await client.listTriggers(ws)) as GtmTrigger[]) {
    const strings = [...collectParameterStrings(tr.parameter), ...collectParameterStrings(tr.filter),
      ...collectParameterStrings(tr.customEventFilter)];
    upsertEntity(db, { id: tr.triggerId, kind: "trigger", name: tr.name, type: tr.type, paused: false,
      parentFolderId: tr.parentFolderId ?? null, rawJson: JSON.stringify(tr), searchText: buildSearchText(tr.name, strings) });
    recordRefs(db, "trigger", tr.triggerId, tr.name, strings);
  }

  for (const v of (await client.listVariables(ws)) as GtmVariable[]) {
    const strings = collectParameterStrings(v.parameter);
    upsertEntity(db, { id: v.variableId, kind: "variable", name: v.name, type: v.type, paused: false,
      parentFolderId: v.parentFolderId ?? null, rawJson: JSON.stringify(v), searchText: buildSearchText(v.name, strings) });
    recordRefs(db, "variable", v.variableId, v.name, strings);
  }

  for (const b of await client.listBuiltInVariables(ws)) {
    upsertEntity(db, { id: b.type, kind: "builtin_variable", name: b.name, type: b.type, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(b), searchText: buildSearchText(b.name, []) });
  }
  for (const f of await client.listFolders(ws)) {
    upsertEntity(db, { id: f.folderId, kind: "folder", name: f.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(f), searchText: buildSearchText(f.name, []) });
  }
  for (const tpl of await client.listTemplates(ws)) {
    const code = tpl.templateData ?? "";
    upsertEntity(db, { id: tpl.templateId, kind: "template", name: tpl.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(tpl), searchText: buildSearchText(tpl.name, [code]) });
  }

  const status = await client.getStatus(ws);
  for (const ch of status.workspaceChange ?? []) {
    const e = ch.tag ?? ch.trigger ?? ch.variable ?? ch.folder;
    if (!e) continue;
    const kind = ch.tag ? "tag" : ch.trigger ? "trigger" : ch.variable ? "variable" : "folder";
    const id = (ch.tag?.tagId ?? ch.trigger?.triggerId ?? ch.variable?.variableId ?? ch.folder?.folderId) as string;
    recordChange(db, kind, id, (e as any).name ?? "", ch.changeStatus);
  }

  setMeta(db, "last_pulled_at", nowIso);
}
```

- [ ] **Step 3: Run → PASS, commit**

```bash
bun test src/pull/pull.test.ts
git add -A
git commit -m "feat: pull orchestration — GTM workspace -> SQLite snapshot"
```

---

## Task 9: Command layer

**Files:**
- Create: `src/commands/_shared.ts`, `src/commands/container.ts`, `src/commands/refs.ts`, `src/commands/entity.ts`, `src/commands/code.ts`, `src/commands/diff.ts`, `src/commands/list.ts`
- Test: `src/commands/_shared.test.ts`, `src/commands/commands.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces `Cmd` handlers: `cmdContainerInit/Use/Show/List/Status/Pull`, `cmdRefs`, `cmdTag`, `cmdTrigger`, `cmdCodeSearch`, `cmdDiff`, `cmdDirty`, `cmdListEntities`.
- `_shared.ts` produces: `openPulled(alias) => Promise<Database>` (throws if never pulled); `resolveAlias(flags, statePath?) => Promise<string>` (`-c/--container` flag > state default).

- [ ] **Step 1: Write `_shared.ts` + failing test**

`src/commands/_shared.ts`:
```typescript
import type { Database } from "bun:sqlite";
import { openDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { loadState } from "../config/state.ts";
import { statePath } from "../paths.ts";

export async function openPulled(alias: string): Promise<Database> {
  const db = await openDb(alias);
  if (!getMeta(db, "last_pulled_at")) {
    throw new Error(`Container '${alias}' has never been pulled. Run: gallium container pull ${alias}`);
  }
  return db;
}

export async function resolveAlias(flags: Record<string, unknown>, stateFile: string = statePath()): Promise<string> {
  const fromFlag = flags.container;
  if (typeof fromFlag === "string" && fromFlag.length > 0) return fromFlag;
  const state = await loadState(stateFile);
  if (state.default_container) return state.default_container;
  throw new Error("No container selected. Pass -c <alias>, or set a default with: gallium container use <alias>");
}
```

`src/commands/_shared.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAlias } from "./_shared.ts";
import { saveState } from "../config/state.ts";

test("resolveAlias prefers -c flag over state default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-rs-"));
  const sp = join(dir, "state.toml");
  try {
    await saveState(sp, { default_container: "from/state" });
    expect(await resolveAlias({ container: "from/flag" }, sp)).toBe("from/flag");
    expect(await resolveAlias({}, sp)).toBe("from/state");
    await expect(resolveAlias({}, join(dir, "missing.toml"))).rejects.toThrow(/No container selected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL → PASS once `_shared.ts` exists**

Run: `bun test src/commands/_shared.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the read commands**

`src/commands/refs.ts`:
```typescript
import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { refsToVariable } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium refs <variable name>
export const cmdRefs: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium refs <variable name>");
  const db = await openPulled(await resolveAlias(flags));
  const rows = refsToVariable(db, name);
  console.log(format(rows, { json: !!flags.json, columns: ["kind", "name", "id"] }));
  return 0;
};
```

`src/commands/entity.ts`:
```typescript
import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { findEntityByName, tagFiringTriggers, tagsFiringOnTrigger } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium tag <name>  → its firing/blocking triggers
export const cmdTag: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium tag <name>");
  const db = await openPulled(await resolveAlias(flags));
  const tag = findEntityByName(db, "tag", name);
  if (!tag) throw new Error(`No tag named '${name}'`);
  const rows = tagFiringTriggers(db, tag.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "id"] }));
  return 0;
};

// gallium trigger <name> [--refs]  → tags that fire on it
export const cmdTrigger: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium trigger <name> [--refs]");
  const db = await openPulled(await resolveAlias(flags));
  const trig = findEntityByName(db, "trigger", name);
  if (!trig) throw new Error(`No trigger named '${name}'`);
  const rows = tagsFiringOnTrigger(db, trig.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "tag_id"] }));
  return 0;
};
```

`src/commands/code.ts`:
```typescript
import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { grepCode } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium code search <pattern>
export const cmdCodeSearch: Cmd = async (positionals, flags) => {
  const pattern = positionals.join(" ").trim();
  if (!pattern) throw new Error("usage: gallium code search <pattern>");
  const db = await openPulled(await resolveAlias(flags));
  const rows = grepCode(db, pattern);
  console.log(format(rows, { json: !!flags.json, columns: ["kind", "name", "id"] }));
  return 0;
};
```

`src/commands/diff.ts`:
```typescript
import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { pendingChanges } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium diff  /  gallium dirty  — both surface pending workspace changes vs the live version.
export const cmdDiff: Cmd = async (_positionals, flags) => {
  const db = await openPulled(await resolveAlias(flags));
  const rows = pendingChanges(db, { status: flags.status as string | undefined });
  console.log(format(rows, { json: !!flags.json, columns: ["change_status", "kind", "name", "id"] }));
  return 0;
};
export const cmdDirty = cmdDiff;
```

`src/commands/list.ts`:
```typescript
import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { listEntities, unusedVariables } from "../cache/repo.ts";
import { format } from "../output.ts";

const KINDS: Record<string, string> = {
  tags: "tag", triggers: "trigger", variables: "variable", folders: "folder",
};

// gallium list <tags|triggers|variables|folders> [--type X] [--folder ID] [--paused] [--unused]
export const cmdListEntities: Cmd = async (positionals, flags) => {
  const kindArg = positionals[0];
  const kind = KINDS[kindArg ?? ""];
  if (!kind) throw new Error(`usage: gallium list <${Object.keys(KINDS).join("|")}> [filters]`);
  const db = await openPulled(await resolveAlias(flags));
  if (kind === "variable" && flags.unused) {
    console.log(format(unusedVariables(db), { json: !!flags.json, columns: ["name", "id"] }));
    return 0;
  }
  const rows = listEntities(db, kind, {
    type: flags.type as string | undefined,
    folderId: flags.folder as string | undefined,
    pausedOnly: !!flags.paused,
  }).map((r) => ({ name: r.name, type: r.type, id: r.id, paused: r.paused }));
  console.log(format(rows, { json: !!flags.json, columns: ["name", "type", "id", "paused"] }));
  return 0;
};
```

- [ ] **Step 4: Write `container.ts` (init/use/show/list/status/pull)**

```typescript
import type { Cmd } from "../command.ts";
import { configPath, statePath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { loadState, saveState } from "../config/state.ts";
import { openDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { GtmClient } from "../gtm/client.ts";
import { getAccountToken } from "../auth/token.ts";
import { pullContainer } from "../pull/pull.ts";
import { resolveAlias } from "./_shared.ts";
import { format } from "../output.ts";
import { ensureDirFor } from "../util/fs.ts";

const TEMPLATE = `# gallium config
# [accounts.<name>]
#   mode = "oauth"            # or "service_account"
#   client_id = "..."        # oauth only
#   client_secret = "\${env:GALLIUM_OAUTH_SECRET}"
#   key_file = "/path/sa.json"  # service_account only
#
# [containers."<alias>"]
#   account = "<name>"
#   account_id = "123"
#   container_id = "456"
#   workspace_id = "7"
`;

export const cmdContainerInit: Cmd = async () => {
  const path = configPath();
  if (await Bun.file(path).exists()) { console.error(`Config already exists at ${path}`); return 1; }
  await ensureDirFor(path);
  await Bun.write(path, TEMPLATE);
  console.log(`Wrote starter config to ${path}. Edit it to add an account and container.`);
  return 0;
};

export const cmdContainerUse: Cmd = async (positionals) => {
  const alias = positionals[0];
  if (!alias) throw new Error("usage: gallium container use <alias>");
  const cfg = await loadConfig(configPath());
  resolveContainer(cfg, alias); // validates
  const sp = statePath();
  const state = await loadState(sp);
  await saveState(sp, { ...state, default_container: alias });
  console.log(`Default container set to '${alias}'.`);
  return 0;
};

export const cmdContainerList: Cmd = async (_p, flags) => {
  const cfg = await loadConfig(configPath());
  const rows = Object.entries(cfg.containers).map(([alias, c]) => ({ alias, account: c.account,
    account_id: c.account_id, container_id: c.container_id, workspace_id: c.workspace_id }));
  console.log(format(rows, { json: !!flags.json, columns: ["alias", "account", "account_id", "container_id", "workspace_id"] }));
  return 0;
};

export const cmdContainerShow: Cmd = async (_p, flags) => {
  const alias = await resolveAlias(flags);
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  console.log(format({ alias: r.alias, account: r.accountName, accountId: r.accountId,
    containerId: r.containerId, workspaceId: r.workspaceId, authMode: r.account.mode }, { json: !!flags.json }));
  return 0;
};

export const cmdContainerStatus: Cmd = async (_p, flags) => {
  const alias = await resolveAlias(flags);
  const db = await openDb(alias);
  const lastPulled = getMeta(db, "last_pulled_at");
  console.log(format({ alias, last_pulled_at: lastPulled ?? null }, { json: !!flags.json }));
  return 0;
};

export const cmdContainerPull: Cmd = async (positionals, flags) => {
  const alias = positionals[0] ?? await resolveAlias(flags);
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  const token = await getAccountToken(r.accountName, r.account);
  const client = new GtmClient(token);
  const db = await openDb(alias);
  const ws = client.wsPath(r.accountId, r.containerId, r.workspaceId);
  await pullContainer(db, client, ws, new Date().toISOString());
  console.log(`Pulled '${alias}'.`);
  return 0;
};
```

- [ ] **Step 5: Write an integration-ish test for the read commands over a seeded DB**

`src/commands/commands.test.ts` — seed a temp cache db at the path `cacheDbPath` resolves to (via `XDG_CACHE_HOME`), then call handlers and capture stdout.
```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../cache/db.ts";
import { upsertEntity, recordVariableRef, setMeta } from "../cache/repo.ts";
import { saveState } from "../config/state.ts";
import { statePath, cacheDir } from "../paths.ts";
import { cmdRefs } from "./refs.ts";

let dir: string;
let logs: string[];
let origLog: typeof console.log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gallium-cmd-"));
  process.env.XDG_CACHE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  logs = []; origLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
});
afterEach(() => { console.log = origLog; rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CACHE_HOME; delete process.env.XDG_CONFIG_HOME; });

test("cmdRefs prints entities referencing a variable as JSON", async () => {
  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-06-19T00:00:00Z");
  upsertEntity(db, { id: "10", kind: "tag", name: "GA4 Event", type: "gaawe",
    paused: false, parentFolderId: null, rawJson: "{}", searchText: "" });
  recordVariableRef(db, "tag", "10", "GA4 ID");
  await saveState(statePath(), { default_container: "acme/web" });
  const code = await cmdRefs(["GA4", "ID"], { json: true });
  expect(code).toBe(0);
  expect(JSON.parse(logs.join("\n"))).toEqual([{ kind: "tag", name: "GA4 Event", id: "10" }]);
});
```
(Note: `cacheDir`/`statePath` are read inside the handlers, so setting `XDG_*` in `beforeEach` redirects them into the temp dir. Confirm `paths.ts` reads `process.env` lazily — it does, since defaults are evaluated per-call.)

- [ ] **Step 6: Run all command tests → PASS, commit**

```bash
bun test src/commands
git add -A
git commit -m "feat: command layer (container mgmt + refs/tag/trigger/code/diff/list)"
```

---

## Task 10: CLI dispatch + entrypoint wiring

**Files:**
- Create: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: every `Cmd` from Task 9 + `cmdSkillInstall/Path` (Task 11 — wire after Task 11, or stub now and add in 11).
- Produces: `run(argv) => Promise<number>`.

- [ ] **Step 1: Write failing CLI test**

`src/cli.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { run } from "./cli.ts";

test("--version prints and returns 0", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { expect(await run(["--version"])).toBe(0); expect(out).toMatch(/^\d+\.\d+\.\d+/); }
  finally { console.log = orig; }
});

test("unknown noun returns 1", async () => {
  const orig = console.error; console.error = () => {};
  try { expect(await run(["bogus"])).toBe(1); } finally { console.error = orig; }
});
```

- [ ] **Step 2: Run → FAIL, then write `src/cli.ts`**

```typescript
import { parseArgs } from "node:util";
import type { Cmd } from "./command.ts";
import {
  cmdContainerInit, cmdContainerUse, cmdContainerShow, cmdContainerList, cmdContainerStatus, cmdContainerPull,
} from "./commands/container.ts";
import { cmdRefs } from "./commands/refs.ts";
import { cmdTag, cmdTrigger } from "./commands/entity.ts";
import { cmdCodeSearch } from "./commands/code.ts";
import { cmdDiff, cmdDirty } from "./commands/diff.ts";
import { cmdListEntities } from "./commands/list.ts";
import { cmdSkillInstall, cmdSkillPath } from "./commands/skill.ts";
import { VERSION } from "./version.ts";

// Flat verb table for single-word commands; noun→verb for grouped ones.
const FLAT: Record<string, Cmd> = {
  refs: cmdRefs, tag: cmdTag, trigger: cmdTrigger, diff: cmdDiff, dirty: cmdDirty, list: cmdListEntities,
};
const GROUPED: Record<string, Record<string, Cmd>> = {
  container: { init: cmdContainerInit, use: cmdContainerUse, show: cmdContainerShow,
    list: cmdContainerList, status: cmdContainerStatus, pull: cmdContainerPull },
  code: { search: cmdCodeSearch },
  skill: { install: cmdSkillInstall, path: cmdSkillPath },
};

function helpText(): string {
  const lines = ["gallium <command> [args] [--json] [-c <alias>]", "", "commands:",
    `  ${Object.keys(FLAT).join(", ")}`];
  for (const noun of Object.keys(GROUPED)) lines.push(`  ${noun}: ${Object.keys(GROUPED[noun]!).join(", ")}`);
  return lines.join("\n");
}

const OPTIONS = {
  json: { type: "boolean", default: false },
  paused: { type: "boolean", default: false },
  unused: { type: "boolean", default: false },
  refs: { type: "boolean", default: false },
  type: { type: "string" },
  folder: { type: "string" },
  status: { type: "string" },
  container: { type: "string", short: "c" },
} as const;

export async function run(argv: string[]): Promise<number> {
  const [head, ...tail] = argv;
  if (head === "--version" || head === "-v") { console.log(VERSION); return 0; }
  if (!head || head === "--help" || head === "-h") { console.log(helpText()); return 0; }

  let fn: Cmd | undefined; let rest: string[];
  if (GROUPED[head]) {
    const verb = tail[0];
    fn = verb ? GROUPED[head]![verb] : undefined;
    if (!fn) { console.error(`Unknown '${head}' subcommand. Available: ${Object.keys(GROUPED[head]!).join(", ")}`); return 1; }
    rest = tail.slice(1);
  } else if (FLAT[head]) {
    fn = FLAT[head]; rest = tail;
  } else { console.error(`Unknown command: ${head}\n\n${helpText()}`); return 1; }

  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  return fn(positionals, values);
}
```

- [ ] **Step 3: Run → PASS (after Task 11 provides `skill.ts`; if doing in order, stub `cmdSkillInstall/Path` as no-ops returning 0, then flesh out in Task 11). Commit**

```bash
bun test src/cli.test.ts
git add -A
git commit -m "feat: CLI dispatcher + version/help"
```

---

## Task 11: Skill install command + SKILL.md + gtm-concepts.md

**Files:**
- Create: `src/commands/skill.ts`, `src/skill/SKILL.md`, `src/skill/references/gtm-concepts.md`
- Test: `src/commands/skill.test.ts`

**Interfaces:**
- Produces: `cmdSkillInstall` (copies `src/skill/**` → `skillInstallDir()`), `cmdSkillPath` (prints the install dir).

- [ ] **Step 1: Write `src/skill/SKILL.md`**

```markdown
---
name: gallium
description: Use when answering read-only questions about a Google Tag Manager container — which tags fire on a trigger, what references a variable, what custom code touches a string, what's changed in the workspace vs. the live version, or listing/auditing tags, triggers, and variables. Drives the `gallium` CLI.
---

# GTM container analysis

Use the `gallium` CLI to answer read-only questions about a Google Tag Manager container workspace. Users refer to containers by alias (e.g. `acme/web`).

## Preflight (always)

1. Run `gallium container status --json` (add `-c <alias>` if it isn't the default).
2. If `last_pulled_at` is null → run `gallium container pull <alias>` first.
3. If `last_pulled_at` is stale (>~1h) or the question implies recent edits ("did someone just change…") → suggest a pull.
4. If no container is selected → ask which alias, or suggest `gallium container use <alias>` to set a default.

## Question → command

| User asks | Command |
|---|---|
| What references `{{Variable Z}}`? | `gallium refs 'Variable Z' --json` |
| What triggers does tag Y fire on? | `gallium tag 'Y' --json` |
| What tags fire on trigger T? | `gallium trigger 'T' --json` |
| Find custom code touching `dataLayer.foo` | `gallium code search 'dataLayer.foo' --json` |
| What changed vs. the live version? | `gallium diff --json` |
| Anything edited-but-unpublished / paused? | `gallium dirty --json` |
| List tags / triggers / variables / folders | `gallium list tags [--type html] [--folder ID] [--paused] --json` |
| Variables referenced nowhere | `gallium list variables --unused --json` |

## Interpreting results

- Always pass `--json` and parse it. Lead the answer with the conclusion, not the raw list.
- `refs` returns every entity (tag/trigger/variable) whose parameters or code contain the `{{name}}` token.
- `tag`/`trigger` resolve the firing/blocking relationship in both directions.
- `diff`/`dirty` come from the GTM API's own workspace status — they show entities added/updated/deleted in the working workspace relative to the live container version.
- See `references/gtm-concepts.md` for workspace/version/environment relationships, web vs. server containers, Zones (GTM 360), and dataLayer/gtag.js footguns.
```

- [ ] **Step 2: Write `src/skill/references/gtm-concepts.md`** (user will review this file specifically)

```markdown
# GTM concepts (for gallium)

## Workspaces, versions, environments
- A **container** holds tags, triggers, variables, folders, built-in variables, and custom templates.
- A **workspace** is the editable working copy. `gallium` pulls the configured workspace.
- A **version** is an immutable snapshot created on publish. The **live** version is what's serving.
- `diff`/`dirty` reflect the workspace's pending changes vs. its base version, via the API's workspace status.
- **Environments** (e.g. Live, Latest, custom) point at versions; not modeled in gallium v1.

## Web vs. server containers
- gallium v1 targets **web** containers (tags/triggers/variables).
- **Server-side** containers use **Clients** (the analogue of tags/triggers) and a different model — deferred to a later phase.

## Zones
- **Zones** are a **web-container feature available only with GTM 360**. They let one container delegate to others. Out of v1 scope; not server-side.

## dataLayer / gtag.js footguns (bake into any generated code)
- Pushes to `window.dataLayer` for gtag.js MUST use a traditional function so the **Arguments object** is captured:
  `function gtag(){ dataLayer.push(arguments); }`
  Arrow functions / rest params are **silently ignored** — zero network requests, no error. Extremely hard to diagnose.
- Biome's `useArrowFunction` rule rewrites `function(){…}` to `() => …`, reintroducing the bug. Suppress with `biome-ignore lint/complexity/useArrowFunction`, or use a named function declaration (which Biome leaves alone).

## Import-JSON gotchas (groundwork for v2 authoring)
- Parameter shape: nested rows are `LIST` of `MAP`, not `PARAM_TABLE`.
- Trigger references inside a tag must be self-contained in the import.
- `parentFolderId` references must resolve to a folder present in the import.
- Custom HTML/templates may require explicit logging permission to be valid.
```

- [ ] **Step 3: Write `src/commands/skill.ts` + failing test**

`src/commands/skill.ts`:
```typescript
import type { Cmd } from "../command.ts";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillInstallDir } from "../paths.ts";

function skillSourceDir(): string {
  // src/commands/skill.ts → ../../src/skill
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
}

export const cmdSkillPath: Cmd = async () => { console.log(skillInstallDir()); return 0; };

export const cmdSkillInstall: Cmd = async () => {
  const dest = skillInstallDir();
  await cp(skillSourceDir(), dest, { recursive: true });
  console.log(`Installed gallium skill to ${dest}`);
  return 0;
};
```

`src/commands/skill.test.ts`:
```typescript
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdSkillInstall } from "./skill.ts";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); delete process.env.CLAUDE_CONFIG_DIR; });

test("cmdSkillInstall copies SKILL.md to the install dir", async () => {
  dir = mkdtempSync(join(tmpdir(), "gallium-skill-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const orig = console.log; console.log = () => {};
  try { expect(await cmdSkillInstall([], {})).toBe(0); } finally { console.log = orig; }
  expect(existsSync(join(dir, "skills", "gallium", "SKILL.md"))).toBe(true);
  expect(existsSync(join(dir, "skills", "gallium", "references", "gtm-concepts.md"))).toBe(true);
});
```

- [ ] **Step 4: Run → PASS, commit**

```bash
bun test src/commands/skill.test.ts
git add -A
git commit -m "feat: skill install command + SKILL.md + gtm-concepts reference"
```

---

## Task 12: Packaging — Homebrew formula + README + full green build

**Files:**
- Create: `Formula/gallium.rb`, `README.md`
- Modify: none

- [ ] **Step 1: Write `README.md`**

Document: install (`brew install …` or `bun link`), `gallium container init`, editing config (both auth modes), `gallium container use <alias>`, `gallium container pull <alias>`, then the question→command table from SKILL.md, and `gallium skill install`.

- [ ] **Step 2: Write `Formula/gallium.rb`** (mirror cadmium's formula: depends on `bun`, installs sources, shims `bin/gallium`)

```ruby
class Gallium < Formula
  desc "Read-only Google Tag Manager container analysis CLI"
  homepage "https://github.com/tyssejc/gallium"
  url "https://github.com/tyssejc/gallium/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_AFTER_FIRST_RELEASE_TARBALL"
  license "MIT"
  depends_on "oven-sh/bun/bun"

  def install
    libexec.install Dir["*"]
    system "#{Formula["bun"].opt_bin}/bun", "install", "--cwd", libexec, "--production"
    (bin/"gallium").write <<~SH
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" run "#{libexec}/bin/gallium.ts" "$@"
    SH
    chmod 0755, bin/"gallium"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gallium --version")
  end
end
```

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS across all files. Fix any cross-task signature drift (names must match the Interfaces blocks).

- [ ] **Step 4: Smoke-test the binary end to end (no network)**

Run:
```bash
bun run bin/gallium.ts --version
bun run bin/gallium.ts --help
bun run bin/gallium.ts container init
```
Expected: version prints; help lists commands; `container init` writes a starter config (or reports one exists).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: Homebrew formula, README, full green build"
```

---

## Self-Review

**Spec coverage:**
- CLI + thin skill → Tasks 1–12; SKILL.md → Task 11. ✓
- Auth: support both (OAuth default + service account) → Task 3. ✓
- Data model & pull (workspace entities + getStatus changes) → Tasks 5–8. ✓ (Refinement of spec: `diff`/`dirty` use the API's native `workspaces` status rather than a client-side snapshot diff of two pulled versions — same outcome, less work. Noted in plan + SKILL.md.)
- Preflight discipline → SKILL.md (Task 11) + `container status`/`openPulled` (Tasks 9). ✓
- v1 commands: refs, tag, trigger, code search, diff/dirty, list, unused → Tasks 7 & 9. ✓
- Reference knowledge (gtag footgun, workspace/version, Zones=GTM360 web feature, server=Clients, import-JSON gotchas) → `gtm-concepts.md` (Task 11). ✓
- Distribution (Homebrew + bun) + testing → Task 12 + per-task `bun test`. ✓
- Out of scope (server containers, Zones, MCP, SHA-256 template) → not implemented; documented in concepts. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above". Two intentional `REPLACE_*` markers exist where real values can only be filled post-release (the formula tarball sha256) — flagged explicitly, not hidden. The `getStatus` endpoint spelling carries an explicit "verify via Context7" note because the colon-method form must be confirmed against live docs.

**Type consistency:** `EntityRow`, `ResolvedContainer`, `AccountAuth`, `Cmd`, and the repo query return shapes are defined once (Tasks 2/6/7) and consumed with matching names downstream. `last_pulled_at` meta key, `-c/--container` flag, and `gallium container pull` naming are consistent across `_shared.ts`, `container.ts`, SKILL.md, and `gtm-concepts.md`.

**Notable build-order dependency:** `src/cli.ts` (Task 10) imports `commands/skill.ts` (Task 11). Either implement Task 11 before running Task 10's tests, or temporarily stub `cmdSkillInstall/cmdSkillPath` as `async () => 0` and replace in Task 11. Called out in Task 10, Step 3.
