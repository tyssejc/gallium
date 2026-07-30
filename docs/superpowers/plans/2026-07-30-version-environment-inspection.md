# Version & Environment Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give gallium read-only visibility into GTM container versions and environments, so it can answer "what version is published to Dev?" and "does my workspace match it?"

**Architecture:** A container is addressed by a *ref* — `<alias>` for the mutable workspace, or `<alias>@v42` / `@live` / `@latest` for an immutable version snapshot. Ref parsing is taught to the single `resolveAlias` → `openPulled` path every analysis command already funnels through, so `list`, `show`, `refs`, `tag`, `trigger`, and `code search` work against a version with no per-command logic. Version snapshots ingest through the *same* code as workspace pulls (`versions.get` returns the same entity arrays) into a version-keyed SQLite file that is cached forever. `diff --against` compares two such entity sets locally by a normalized content hash, since the GTM API has no version-vs-version diff.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun:test`, `smol-toml`. No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-07-30-version-environment-inspection-design.md`

## Global Constraints

- **No new dependencies.** Everything uses Bun builtins (`Bun.CryptoHasher`, `bun:sqlite`) or what's already in `package.json`.
- **Read-only.** Every GTM call added is a GET. No writes, no new OAuth scopes.
- **Test command is `bun test`.** Single file: `bun test src/hash.test.ts`. Single test: `bun test src/hash.test.ts -t "name"`.
- **Existing behavior is preserved byte-for-byte.** `gallium diff` with no `--against` must produce exactly today's output. Every existing test must still pass at the end of every task.
- **Style:** match the surrounding code — 2-space indent, double quotes, `.ts` extensions on relative imports, `export const cmdX: Cmd = async (positionals, flags) => {...}` for commands, `throw new Error(...)` for user-facing errors (the CLI wrapper turns them into exit codes), `console.log(format(rows, { json: !!flags.json, columns: [...] }))` for output.
- **Entity ID stability assumption:** GTM preserves `tagId`/`triggerId`/`variableId` when a workspace is published to a version. The whole comparison rests on this.
- **STRIP list (verbatim, used in Task 2):** `path`, `fingerprint`, `accountId`, `containerId`, `workspaceId`, `containerVersionId`, `tagManagerUrl`.

---

### Task 1: Container ref parsing

Introduces the `<alias>@<snapshot>` grammar and the version-keyed cache path. Pure functions, no I/O — this is the vocabulary every later task speaks.

**Files:**
- Create: `src/config/ref.ts`
- Create: `src/config/ref.test.ts`
- Modify: `src/paths.ts` (append `versionDbPath`)
- Modify: `src/paths.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SnapshotRef = { kind: "version"; id: string } | { kind: "live" } | { kind: "latest" } | { kind: "env"; name: string }`
  - `interface ContainerRef { alias: string; snapshot: SnapshotRef | null }`
  - `parseContainerRef(raw: string): ContainerRef` — for `-c` values. Accepts `@vN`, `@live`, `@latest`. **Rejects `env:`** (an env is not a stable cache key on the `-c` side).
  - `parseAgainst(raw: string): SnapshotRef` — for `--against` values. Accepts `<digits>`, `env:<name>`, `live`, `latest`.
  - `describeSnapshot(s: SnapshotRef): string` — human phrase for error/preflight messages.
  - `versionDbPath(alias: string, versionId: string, env?): string`

- [ ] **Step 1: Write the failing test**

Create `src/config/ref.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseContainerRef, parseAgainst, describeSnapshot } from "./ref.ts";

test("parseContainerRef: bare alias is a workspace ref", () => {
  expect(parseContainerRef("acme/web")).toEqual({ alias: "acme/web", snapshot: null });
});

test("parseContainerRef: @vN, @live, @latest", () => {
  expect(parseContainerRef("acme/web@v42")).toEqual({ alias: "acme/web", snapshot: { kind: "version", id: "42" } });
  expect(parseContainerRef("acme/web@live")).toEqual({ alias: "acme/web", snapshot: { kind: "live" } });
  expect(parseContainerRef("acme/web@latest")).toEqual({ alias: "acme/web", snapshot: { kind: "latest" } });
});

test("parseContainerRef: rejects malformed suffixes", () => {
  expect(() => parseContainerRef("acme/web@")).toThrow(/Valid forms/);
  expect(() => parseContainerRef("acme/web@v")).toThrow(/Valid forms/);
  expect(() => parseContainerRef("acme/web@nope")).toThrow(/Valid forms/);
  expect(() => parseContainerRef("@v42")).toThrow(/no alias/);
  expect(() => parseContainerRef("")).toThrow(/[Ee]mpty/);
});

test("parseContainerRef: @v0 is rejected because the API treats 0 as 'latest'", () => {
  expect(() => parseContainerRef("acme/web@v0")).toThrow(/@latest/);
});

test("parseContainerRef: rejects env: on the -c side", () => {
  expect(() => parseContainerRef("acme/web@env:dev")).toThrow(/--against/);
});

test("parseAgainst: all four target forms", () => {
  expect(parseAgainst("42")).toEqual({ kind: "version", id: "42" });
  expect(parseAgainst("env:dev")).toEqual({ kind: "env", name: "dev" });
  expect(parseAgainst("env:My Env")).toEqual({ kind: "env", name: "My Env" });
  expect(parseAgainst("live")).toEqual({ kind: "live" });
  expect(parseAgainst("latest")).toEqual({ kind: "latest" });
});

test("parseAgainst: rejects junk, empty env name, and version 0", () => {
  expect(() => parseAgainst("v42")).toThrow(/Valid forms/);
  expect(() => parseAgainst("env:")).toThrow(/environment name/);
  expect(() => parseAgainst("0")).toThrow(/latest/);
});

test("describeSnapshot produces readable phrases", () => {
  expect(describeSnapshot({ kind: "version", id: "42" })).toBe("version 42");
  expect(describeSnapshot({ kind: "live" })).toBe("the live version");
  expect(describeSnapshot({ kind: "latest" })).toBe("the latest version");
  expect(describeSnapshot({ kind: "env", name: "Dev" })).toBe("environment 'Dev'");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config/ref.test.ts`
Expected: FAIL — `Cannot find module './ref.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/config/ref.ts`:

```ts
export type SnapshotRef =
  | { kind: "version"; id: string }
  | { kind: "live" }
  | { kind: "latest" }
  | { kind: "env"; name: string };

export interface ContainerRef {
  alias: string;
  snapshot: SnapshotRef | null;
}

const CONTAINER_FORMS = "@v<N>, @live, @latest";
const AGAINST_FORMS = "<versionId>, env:<name>, live, latest";

// A container ref is `<alias>[@<snapshot>]`. Aliases may contain '/', never '@'.
export function parseContainerRef(raw: string): ContainerRef {
  if (raw.length === 0) throw new Error("Empty container ref.");
  const at = raw.lastIndexOf("@");
  if (at === -1) return { alias: raw, snapshot: null };
  const alias = raw.slice(0, at);
  const suffix = raw.slice(at + 1);
  if (alias.length === 0) throw new Error(`Container ref '${raw}' has no alias before '@'.`);
  if (suffix.startsWith("env:")) {
    throw new Error(`An environment is not a stable snapshot ref. Use --against env:<name> instead of '@${suffix}'.`);
  }
  if (suffix === "live") return { alias, snapshot: { kind: "live" } };
  if (suffix === "latest") return { alias, snapshot: { kind: "latest" } };
  const m = /^v(\d+)$/.exec(suffix);
  if (!m) throw new Error(`Invalid snapshot ref '@${suffix}' in '${raw}'. Valid forms: ${CONTAINER_FORMS}`);
  const id = m[1]!;
  if (/^0+$/.test(id)) {
    throw new Error("Version '@v0' means 'latest' to the GTM API and is not a stable snapshot. Use '@latest'.");
  }
  return { alias, snapshot: { kind: "version", id } };
}

// --against accepts everything a container ref does, plus env:<name>.
export function parseAgainst(raw: string): SnapshotRef {
  if (raw.startsWith("env:")) {
    const name = raw.slice(4);
    if (name.length === 0) throw new Error("'--against env:' needs an environment name, e.g. env:dev");
    return { kind: "env", name };
  }
  if (raw === "live") return { kind: "live" };
  if (raw === "latest") return { kind: "latest" };
  if (/^\d+$/.test(raw)) {
    if (/^0+$/.test(raw)) throw new Error("Version '0' means 'latest' to the GTM API. Use --against latest.");
    return { kind: "version", id: raw };
  }
  throw new Error(`Invalid --against target '${raw}'. Valid forms: ${AGAINST_FORMS}`);
}

export function describeSnapshot(s: SnapshotRef): string {
  switch (s.kind) {
    case "version": return `version ${s.id}`;
    case "live": return "the live version";
    case "latest": return "the latest version";
    case "env": return `environment '${s.name}'`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/config/ref.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Add the cache path helper test**

Append to `src/paths.test.ts`:

```ts
test("versionDbPath keys the cache file by alias and version id", () => {
  const env = { HOME: "/home/u", XDG_CACHE_HOME: "/c" };
  expect(versionDbPath("acme/web", "42", env)).toBe("/c/gallium/acme/web@v42.db");
  expect(versionDbPath("acme/web", "42", { HOME: "/home/u" })).toBe("/home/u/.cache/gallium/acme/web@v42.db");
});
```

Add `versionDbPath` to the existing import at the top of `src/paths.test.ts`.

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/paths.test.ts`
Expected: FAIL — `versionDbPath is not a function`

- [ ] **Step 7: Implement `versionDbPath`**

Append to `src/paths.ts`, directly after `cacheDbPath`:

```ts
export function versionDbPath(alias: string, versionId: string, env: Env = process.env): string {
  return `${cacheDir(env)}/${alias}@v${versionId}.db`;
}
```

- [ ] **Step 8: Run the full suite**

Run: `bun test`
Expected: PASS — all existing tests plus 9 new ones

- [ ] **Step 9: Commit**

```bash
git add src/config/ref.ts src/config/ref.test.ts src/paths.ts src/paths.test.ts
git commit -m "feat(ref): parse <alias>@vN/@live/@latest container refs"
```

---

### Task 2: Normalized content hash

The equality rule for version-vs-version comparison. `fingerprint` is useless here (GTM recomputes it when a version is stored, so every entity would look changed) and raw JSON always differs on location fields. So: strip a denylist, canonicalize key order, hash.

**Files:**
- Create: `src/hash.ts` (top-level, alongside `output.ts` / `paths.ts` — it's a general utility, and putting it under `pull/` would force `cache/repo.ts` to import upward)
- Create: `src/hash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `STRIP_KEYS: ReadonlySet<string>`
  - `normalizeForHash(value: unknown): unknown`
  - `contentHash(entity: unknown): string` — 64-char lowercase hex sha256

- [ ] **Step 1: Write the failing test**

Create `src/hash.test.ts`:

```ts
import { test, expect } from "bun:test";
import { contentHash, normalizeForHash, STRIP_KEYS } from "./hash.ts";

test("stripped keys are removed at the top level", () => {
  const ws = { tagId: "10", name: "GA4", path: "accounts/1/containers/2/workspaces/3/tags/10",
    fingerprint: "111", workspaceId: "3", accountId: "1", containerId: "2" };
  const ver = { tagId: "10", name: "GA4", path: "accounts/1/containers/2/versions/42/tags/10",
    fingerprint: "999", containerVersionId: "42", accountId: "1", containerId: "2" };
  expect(contentHash(ws)).toBe(contentHash(ver));
});

test("stripped keys are removed inside nested objects and arrays", () => {
  const a = { tagId: "10", parameter: [{ key: "id", value: "X", fingerprint: "aaa" }] };
  const b = { tagId: "10", parameter: [{ key: "id", value: "X", fingerprint: "bbb" }] };
  expect(contentHash(a)).toBe(contentHash(b));
});

test("key order does not affect the hash", () => {
  expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHash({ b: { d: 3, c: 2 }, a: 1 }));
});

test("a change in any non-stripped field changes the hash", () => {
  const base = { tagId: "10", name: "GA4", paused: false };
  expect(contentHash({ ...base, name: "GA4 v2" })).not.toBe(contentHash(base));
  expect(contentHash({ ...base, paused: true })).not.toBe(contentHash(base));
  // An unmodeled field gallium knows nothing about still counts as content.
  expect(contentHash({ ...base, someFutureField: "x" })).not.toBe(contentHash(base));
});

test("array order is significant", () => {
  expect(contentHash({ firingTriggerId: ["1", "2"] })).not.toBe(contentHash({ firingTriggerId: ["2", "1"] }));
});

test("normalizeForHash drops every documented STRIP key", () => {
  const input: Record<string, unknown> = { keep: 1 };
  for (const k of STRIP_KEYS) input[k] = "drop me";
  expect(normalizeForHash(input)).toEqual({ keep: 1 });
});

test("contentHash returns 64-char lowercase hex", () => {
  expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/hash.test.ts`
Expected: FAIL — `Cannot find module './hash.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/hash.ts`:

```ts
// Fields that identify *where* an entity is stored rather than *what* it is.
// A version is a fresh stored copy of a workspace's entities, so GTM recomputes
// `fingerprint` and rewrites `path` for every one of them — comparing those would
// report total drift. Everything NOT listed here counts as content, including
// fields gallium does not model: a benign new API field will read as `updated`
// until it is added here, which is the safe direction to be wrong in.
export const STRIP_KEYS: ReadonlySet<string> = new Set([
  "path", "fingerprint", "accountId", "containerId",
  "workspaceId", "containerVersionId", "tagManagerUrl",
]);

export function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (STRIP_KEYS.has(key)) continue;
      out[key] = normalizeForHash(src[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(entity: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(normalizeForHash(entity)));
  return hasher.digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/hash.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/hash.ts src/hash.test.ts
git commit -m "feat(hash): normalized content hash for entity comparison"
```

---

### Task 3: GTM client — environments, version headers, versions

Four read-only GET endpoints on the existing `getJson`/`listAll` primitives.

**Files:**
- Modify: `src/gtm/types.ts` (append three interfaces)
- Modify: `src/gtm/client.ts` (append `containerPath` + five methods)
- Modify: `src/gtm/client.test.ts` (append tests)

**Interfaces:**
- Consumes: nothing.
- Produces, on `GtmClient`:
  - `containerPath(accountId: string, containerId: string): string`
  - `listEnvironments(accountId, containerId): Promise<GtmEnvironment[]>`
  - `listVersionHeaders(accountId, containerId): Promise<GtmVersionHeader[]>`
  - `getVersion(accountId, containerId, versionId: string): Promise<GtmContainerVersion>`
  - `getLiveVersion(accountId, containerId): Promise<GtmContainerVersion>`
  - `getLatestVersionHeader(accountId, containerId): Promise<GtmVersionHeader>`
- And types `GtmEnvironment`, `GtmVersionHeader`, `GtmContainerVersion` from `src/gtm/types.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/gtm/client.test.ts`:

```ts
test("listEnvironments hits containers/<id>/environments and extracts environment field", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ environment: [
      { environmentId: "1", name: "Live", type: "live", containerVersionId: "42" },
      { environmentId: "3", name: "Dev", type: "user", containerVersionId: "41" },
    ] });
  }) as unknown as typeof fetch;
  const envs = await new GtmClient("tok", fetchFn).listEnvironments("111", "222");
  expect(calls[0]).toContain("accounts/111/containers/222/environments");
  expect(envs.map((e) => e.name)).toEqual(["Live", "Dev"]);
  expect(envs[1]!.containerVersionId).toBe("41");
});

test("listVersionHeaders extracts containerVersionHeader and follows nextPageToken", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.includes("pageToken=p2")) {
      return jsonResponse({ containerVersionHeader: [{ containerVersionId: "41", name: "older" }] });
    }
    return jsonResponse({
      containerVersionHeader: [{ containerVersionId: "42", name: "newest", numTags: "9" }],
      nextPageToken: "p2",
    });
  }) as unknown as typeof fetch;
  const headers = await new GtmClient("tok", fetchFn).listVersionHeaders("111", "222");
  expect(calls[0]).toContain("accounts/111/containers/222/version_headers");
  expect(headers.map((h) => h.containerVersionId)).toEqual(["42", "41"]);
  expect(headers[0]!.numTags).toBe("9");
});

test("getVersion fetches a single version snapshot with its entity arrays", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ containerVersionId: "42", name: "go-live", notes: "category pixels",
      tag: [{ tagId: "10", name: "GA4" }], trigger: [], variable: [] });
  }) as unknown as typeof fetch;
  const v = await new GtmClient("tok", fetchFn).getVersion("111", "222", "42");
  expect(calls[0]).toContain("accounts/111/containers/222/versions/42");
  expect(v.containerVersionId).toBe("42");
  expect(v.notes).toBe("category pixels");
  expect(v.tag?.[0]?.tagId).toBe("10");
});

test("getLiveVersion and getLatestVersionHeader hit their special endpoints", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ containerVersionId: "42" });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  expect((await client.getLiveVersion("111", "222")).containerVersionId).toBe("42");
  expect((await client.getLatestVersionHeader("111", "222")).containerVersionId).toBe("42");
  expect(calls[0]).toContain("accounts/111/containers/222/versions:live");
  expect(calls[1]).toContain("accounts/111/containers/222/version_headers:latest");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/gtm/client.test.ts`
Expected: FAIL — `client.listEnvironments is not a function`

- [ ] **Step 3: Add the types**

Append to `src/gtm/types.ts`:

```ts
export interface GtmEnvironment {
  environmentId: string; name: string; type: string;
  containerVersionId?: string; authorizationCode?: string; workspaceId?: string;
}
// NOTE: ContainerVersionHeader carries no timestamp and no notes — both are
// deliberately absent from `gallium versions` output for that reason.
export interface GtmVersionHeader {
  containerVersionId: string; name?: string; deleted?: boolean;
  numMacros?: string; numRules?: string; numTags?: string;
  numTriggers?: string; numVariables?: string;
}
export interface GtmContainerVersion {
  containerVersionId: string; name?: string; notes?: string; deleted?: boolean;
  tag?: GtmTag[]; trigger?: GtmTrigger[]; variable?: GtmVariable[];
  builtInVariable?: GtmBuiltInVariable[]; folder?: GtmFolder[]; customTemplate?: GtmTemplate[];
}
```

- [ ] **Step 4: Add the client methods**

In `src/gtm/client.ts`, extend the type import at the top with `GtmEnvironment, GtmVersionHeader, GtmContainerVersion`, then append these methods to the class, after `listWorkspaces`:

```ts
  containerPath(accountId: string, containerId: string): string {
    return `accounts/${accountId}/containers/${containerId}`;
  }

  listEnvironments(accountId: string, containerId: string): Promise<GtmEnvironment[]> {
    return this.listAll(`${this.containerPath(accountId, containerId)}/environments`, "environment");
  }
  listVersionHeaders(accountId: string, containerId: string): Promise<GtmVersionHeader[]> {
    return this.listAll(`${this.containerPath(accountId, containerId)}/version_headers`, "containerVersionHeader");
  }
  getVersion(accountId: string, containerId: string, versionId: string): Promise<GtmContainerVersion> {
    return this.getJson(`${this.containerPath(accountId, containerId)}/versions/${versionId}`);
  }
  getLiveVersion(accountId: string, containerId: string): Promise<GtmContainerVersion> {
    return this.getJson(`${this.containerPath(accountId, containerId)}/versions:live`);
  }
  getLatestVersionHeader(accountId: string, containerId: string): Promise<GtmVersionHeader> {
    return this.getJson(`${this.containerPath(accountId, containerId)}/version_headers:latest`);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/gtm/client.test.ts`
Expected: PASS — 4 existing + 4 new

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/gtm/types.ts src/gtm/client.ts src/gtm/client.test.ts
git commit -m "feat(gtm): read environments, version headers, and version snapshots"
```

---

### Task 4: Schema v2 + ingest refactor

Splits fetching from ingesting so a version snapshot — which arrives as one response containing all the entity arrays — reuses the exact code path a workspace pull uses. Adds the `content_hash` column, computed inside `upsertEntity` from `raw_json` so no call site can forget it.

**Files:**
- Modify: `src/cache/schema.ts` (bump version, add column)
- Modify: `src/cache/repo.ts` (compute hash in `upsertEntity`, add `allEntityHashes`)
- Modify: `src/cache/db.ts` (add `openVersionDb`)
- Modify: `src/pull/pull.ts` (split into `ingestEntities` / `pullWorkspace` / `pullVersion`)
- Modify: `src/commands/container.ts:9,100` (rename `pullContainer` → `pullWorkspace`)
- Modify: `src/pull/pull.test.ts` (rename call, add a `pullVersion` test)
- Modify: `src/cache/repo.test.ts` (add an `allEntityHashes` test)

**Interfaces:**
- Consumes: `contentHash` from `src/hash.ts` (Task 2); `GtmContainerVersion` from `src/gtm/types.ts` (Task 3); `versionDbPath` from `src/paths.ts` (Task 1).
- Produces:
  - `SCHEMA_VERSION = 2`, `entities.content_hash TEXT NOT NULL DEFAULT ''`
  - `allEntityHashes(db): { kind: string; id: string; name: string; content_hash: string }[]`
  - `openVersionDb(alias: string, versionId: string): Promise<Database>`
  - `interface EntitySnapshot { tag?; trigger?; variable?; builtInVariable?; folder?; customTemplate? }`
  - `ingestEntities(db: Database, snap: EntitySnapshot): void`
  - `pullWorkspace(db, client, ws: string, nowIso: string): Promise<void>` — replaces `pullContainer`, same behavior
  - `pullVersion(db, client, accountId, containerId, versionId, nowIso): Promise<GtmContainerVersion>`

**Note on the schema bump:** `openDbAt` already drops every table when the stored `schema_version` doesn't match, so existing caches self-invalidate. The user-visible effect is that the first command after upgrading says "has never been pulled" and needs one `gallium container pull`. That is intended; Task 9 documents it.

- [ ] **Step 1: Write the failing tests**

Append to `src/cache/repo.test.ts`, adding `allEntityHashes` to its existing `./repo.ts` import and
`openDbAt` to its `./db.ts` import (add that import line if the file doesn't already have one):

```ts
test("upsertEntity derives content_hash from raw_json, ignoring location fields", () => {
  const db = openDbAt(":memory:");
  upsertEntity(db, { id: "10", kind: "tag", name: "GA4", type: "gaawe", paused: false, parentFolderId: null,
    rawJson: JSON.stringify({ tagId: "10", name: "GA4", fingerprint: "aaa", workspaceId: "3" }), searchText: "" });
  const fromWorkspace = allEntityHashes(db)[0]!.content_hash;

  const db2 = openDbAt(":memory:");
  upsertEntity(db2, { id: "10", kind: "tag", name: "GA4", type: "gaawe", paused: false, parentFolderId: null,
    rawJson: JSON.stringify({ tagId: "10", name: "GA4", fingerprint: "zzz", containerVersionId: "42" }), searchText: "" });
  expect(allEntityHashes(db2)[0]!.content_hash).toBe(fromWorkspace);
  expect(fromWorkspace).toMatch(/^[0-9a-f]{64}$/);
});

test("allEntityHashes returns every entity kind with a stable ordering", () => {
  const db = openDbAt(":memory:");
  upsertEntity(db, { id: "50", kind: "trigger", name: "All Pages", type: "pageview", paused: false,
    parentFolderId: null, rawJson: "{}", searchText: "" });
  upsertEntity(db, { id: "10", kind: "tag", name: "GA4", type: "gaawe", paused: false,
    parentFolderId: null, rawJson: "{}", searchText: "" });
  expect(allEntityHashes(db).map((e) => `${e.kind}:${e.id}`)).toEqual(["tag:10", "trigger:50"]);
});
```

Append to `src/pull/pull.test.ts`:

```ts
test("pullVersion ingests a version snapshot through the same path and records version meta", async () => {
  const versionClient = {
    getVersion: async () => ({
      containerVersionId: "42", name: "go-live", notes: "category pixels",
      tag: [{ tagId: "10", name: "GA4 Event", type: "gaawe",
        parameter: [{ type: "template", key: "measurementId", value: "{{GA4 ID}}" }],
        firingTriggerId: ["50"] }],
      trigger: [{ triggerId: "50", name: "All Pages", type: "pageview" }],
      variable: [{ variableId: "v1", name: "GA4 ID", type: "c" }],
      builtInVariable: [{ type: "pageUrl", name: "Page URL" }],
      folder: [], customTemplate: [],
    }),
  } as any;
  const db = openDbAt(":memory:");
  const v = await pullVersion(db, versionClient, "111", "222", "42", "2026-07-30T00:00:00Z");
  expect(v.containerVersionId).toBe("42");
  expect(refsToVariable(db, "GA4 ID").map((r) => r.name)).toEqual(["GA4 Event"]);
  expect(tagFiringTriggers(db, "10")).toEqual([{ id: "50", name: "All Pages", relation: "firing" }]);
  expect(getMeta(db, "source")).toBe("version");
  expect(getMeta(db, "version_id")).toBe("42");
  expect(getMeta(db, "version_name")).toBe("go-live");
  expect(getMeta(db, "last_pulled_at")).toBe("2026-07-30T00:00:00Z");
  // A version has no pending changes.
  expect(pendingChanges(db, {})).toEqual([]);
});
```

Update the top of `src/pull/pull.test.ts`: change the import to `import { pullWorkspace, pullVersion } from "./pull.ts";` and rename the existing `pullContainer(...)` call in the first test to `pullWorkspace(...)`. Also add to that first test's assertions:

```ts
  expect(getMeta(db, "source")).toBe("workspace");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/pull/pull.test.ts src/cache/repo.test.ts`
Expected: FAIL — `pullWorkspace is not exported`, `allEntityHashes is not a function`

- [ ] **Step 3: Bump the schema**

In `src/cache/schema.ts`, change `export const SCHEMA_VERSION = 1;` to `= 2;`, and add the column to the `entities` table definition — insert after the `search_text` line, before `PRIMARY KEY`:

```sql
  content_hash TEXT NOT NULL DEFAULT '',   -- sha256 of raw_json minus location fields
```

- [ ] **Step 4: Compute the hash in the repo and add the accessor**

In `src/cache/repo.ts`, add the import at the top:

```ts
import { contentHash } from "../hash.ts";
```

Replace the body of `upsertEntity` with:

```ts
export function upsertEntity(db: Database, r: EntityRow): void {
  // Derived here, not at the call site, so every writer gets a consistent hash.
  const hash = contentHash(r.rawJson ? JSON.parse(r.rawJson) : {});
  db.query(`INSERT INTO entities (id,kind,name,type,paused,parent_folder_id,raw_json,search_text,content_hash)
    VALUES ($id,$kind,$name,$type,$paused,$folder,$raw,$search,$hash)
    ON CONFLICT(kind,id) DO UPDATE SET name=$name,type=$type,paused=$paused,
      parent_folder_id=$folder,raw_json=$raw,search_text=$search,content_hash=$hash`).run({
    $id: r.id, $kind: r.kind, $name: r.name, $type: r.type, $paused: r.paused ? 1 : 0,
    $folder: r.parentFolderId, $raw: r.rawJson, $search: r.searchText, $hash: hash,
  });
}
```

Append this accessor to `src/cache/repo.ts`:

```ts
export function allEntityHashes(db: Database): { kind: string; id: string; name: string; content_hash: string }[] {
  return db.query(`SELECT kind,id,name,content_hash FROM entities ORDER BY kind,id`).all() as any;
}
```

- [ ] **Step 5: Add `openVersionDb`**

In `src/cache/db.ts`, extend the paths import to `import { cacheDbPath, versionDbPath } from "../paths.ts";` and append:

```ts
export async function openVersionDb(alias: string, versionId: string): Promise<Database> {
  const path = versionDbPath(alias, versionId);
  await ensureDirFor(path);
  return openDbAt(path);
}
```

Add `import type { Database } from "bun:sqlite";` if the file does not already have a `Database` type in scope (it imports the value `Database` from `bun:sqlite`, which serves as a type too — no change needed).

- [ ] **Step 6: Split pull.ts**

Rewrite `src/pull/pull.ts`. Keep `conditionStrings`, `recordRefs`, and the imports at the top as they are, adding `GtmBuiltInVariable, GtmFolder, GtmTemplate, GtmContainerVersion` to the type import from `../gtm/types.ts`. Replace `pullContainer` with:

```ts
export interface EntitySnapshot {
  tag?: GtmTag[]; trigger?: GtmTrigger[]; variable?: GtmVariable[];
  builtInVariable?: GtmBuiltInVariable[]; folder?: GtmFolder[]; customTemplate?: GtmTemplate[];
}

// Pure ingest — no client. Workspaces and version snapshots deliver the same
// entity arrays, so both funnel through here.
export function ingestEntities(db: Database, snap: EntitySnapshot): void {
  for (const t of snap.tag ?? []) {
    const strings = collectParameterStrings(t.parameter);
    upsertEntity(db, { id: t.tagId, kind: "tag", name: t.name, type: t.type, paused: !!t.paused,
      parentFolderId: t.parentFolderId ?? null, rawJson: JSON.stringify(t), searchText: buildSearchText(t.name, strings) });
    recordRefs(db, "tag", t.tagId, strings);
    for (const trig of t.firingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "firing");
    for (const trig of t.blockingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "blocking");
  }

  for (const tr of snap.trigger ?? []) {
    const strings = [
      ...collectParameterStrings(tr.parameter),
      ...conditionStrings(tr.filter),
      ...conditionStrings(tr.customEventFilter),
      ...conditionStrings(tr.autoEventFilter),
    ];
    upsertEntity(db, { id: tr.triggerId, kind: "trigger", name: tr.name, type: tr.type, paused: false,
      parentFolderId: tr.parentFolderId ?? null, rawJson: JSON.stringify(tr), searchText: buildSearchText(tr.name, strings) });
    recordRefs(db, "trigger", tr.triggerId, strings);
  }

  for (const v of snap.variable ?? []) {
    const strings = collectParameterStrings(v.parameter);
    upsertEntity(db, { id: v.variableId, kind: "variable", name: v.name, type: v.type, paused: false,
      parentFolderId: v.parentFolderId ?? null, rawJson: JSON.stringify(v), searchText: buildSearchText(v.name, strings) });
    recordRefs(db, "variable", v.variableId, strings);
  }

  for (const b of snap.builtInVariable ?? []) {
    upsertEntity(db, { id: b.type, kind: "builtin_variable", name: b.name, type: b.type, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(b), searchText: buildSearchText(b.name, []) });
  }
  for (const f of snap.folder ?? []) {
    upsertEntity(db, { id: f.folderId, kind: "folder", name: f.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(f), searchText: buildSearchText(f.name, []) });
  }
  for (const tpl of snap.customTemplate ?? []) {
    const code = tpl.templateData ?? "";
    upsertEntity(db, { id: tpl.templateId, kind: "template", name: tpl.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(tpl), searchText: buildSearchText(tpl.name, [code]) });
  }
}

export async function pullWorkspace(db: Database, client: GtmClient, ws: string, nowIso: string): Promise<void> {
  resetDerived(db);
  // Workspaces expose custom templates via a separate list call; versions inline
  // them as `customTemplate`. Normalized here so ingest sees one shape.
  ingestEntities(db, {
    tag: await client.listTags(ws),
    trigger: await client.listTriggers(ws),
    variable: await client.listVariables(ws),
    builtInVariable: await client.listBuiltInVariables(ws),
    folder: await client.listFolders(ws),
    customTemplate: await client.listTemplates(ws),
  });

  const status = await client.getStatus(ws);
  for (const ch of status.workspaceChange ?? []) {
    const e = ch.tag ?? ch.trigger ?? ch.variable ?? ch.folder ?? ch.builtInVariable ?? ch.customTemplate;
    if (!e) continue;
    const kind = ch.tag ? "tag"
      : ch.trigger ? "trigger"
      : ch.variable ? "variable"
      : ch.folder ? "folder"
      : ch.builtInVariable ? "builtin_variable"
      : "template";
    const id = (ch.tag?.tagId ?? ch.trigger?.triggerId ?? ch.variable?.variableId
      ?? ch.folder?.folderId ?? ch.builtInVariable?.type ?? ch.customTemplate?.templateId) as string;
    recordChange(db, kind, id, (e as any).name ?? "", ch.changeStatus);
  }

  setMeta(db, "source", "workspace");
  setMeta(db, "last_pulled_at", nowIso);
}

// Version snapshots are immutable: one GET, ingest, done. No status call —
// a version has no pending changes.
export async function pullVersion(
  db: Database, client: GtmClient, accountId: string, containerId: string,
  versionId: string, nowIso: string,
): Promise<GtmContainerVersion> {
  const version = await client.getVersion(accountId, containerId, versionId);
  resetDerived(db);
  ingestEntities(db, version);
  setMeta(db, "source", "version");
  setMeta(db, "version_id", version.containerVersionId ?? versionId);
  setMeta(db, "version_name", version.name ?? "");
  setMeta(db, "last_pulled_at", nowIso);
  return version;
}
```

- [ ] **Step 7: Update the one production caller**

In `src/commands/container.ts`, change line 9's import from `pullContainer` to `pullWorkspace`, and line 100's call from `await pullContainer(db, client, ws, ...)` to `await pullWorkspace(db, client, ws, ...)`.

- [ ] **Step 8: Run the full suite**

Run: `bun test`
Expected: PASS. If `commands.test.ts` fails, it means `upsertEntity`'s signature changed — it should not have; the hash is derived internally precisely so those call sites are untouched.

- [ ] **Step 9: Commit**

```bash
git add src/cache/schema.ts src/cache/repo.ts src/cache/repo.test.ts src/cache/db.ts \
        src/pull/pull.ts src/pull/pull.test.ts src/commands/container.ts
git commit -m "refactor(pull): split ingest from fetch, add pullVersion and content_hash

Schema 1->2. Existing caches self-invalidate and need one re-pull."
```

---

### Task 5: `gallium environments` and `gallium versions`

The first user-visible surface. Both are live-fetch list commands that need no local cache — deliberately, since a stale answer to "what's on Dev" is a wrong answer.

**Files:**
- Create: `src/commands/versionInfo.ts` (both commands — they share the config/client/alias preamble)
- Create: `src/commands/versionInfo.test.ts`
- Modify: `src/cli.ts` (register commands, add `--limit`)

**Interfaces:**
- Consumes: `parseContainerRef` (Task 1); `listEnvironments`, `listVersionHeaders` (Task 3); `resolveAlias` from `./_shared.ts`.
- Produces:
  - `cmdEnvironments: Cmd`, `cmdVersions: Cmd`
  - `environmentRows(envs: GtmEnvironment[], headers: GtmVersionHeader[]): Row[]` — exported pure function so output shaping is testable without network
  - `versionRows(headers: GtmVersionHeader[], limit: number): Row[]` — same

- [ ] **Step 1: Write the failing test**

Create `src/commands/versionInfo.test.ts`:

```ts
import { test, expect } from "bun:test";
import { environmentRows, versionRows } from "./versionInfo.ts";

test("environmentRows joins each environment to the name of the version it points at", () => {
  const rows = environmentRows(
    [
      { environmentId: "1", name: "Live", type: "live", containerVersionId: "42" },
      { environmentId: "3", name: "Dev", type: "user", containerVersionId: "41" },
    ],
    [
      { containerVersionId: "42", name: "go-live" },
      { containerVersionId: "41", name: "category pixels" },
    ],
  );
  expect(rows).toEqual([
    { name: "Live", type: "live", environment_id: "1", version_id: "42", version_name: "go-live" },
    { name: "Dev", type: "user", environment_id: "3", version_id: "41", version_name: "category pixels" },
  ]);
});

test("environmentRows renders an unpinned environment as tracking the newest publish", () => {
  const [row] = environmentRows(
    [{ environmentId: "2", name: "Latest", type: "latest", containerVersionId: "0" }], []);
  expect(row!.version_id).toBe("latest");
  expect(row!.version_name).toBe("(tracks newest publish)");
});

test("environmentRows tolerates a missing containerVersionId and an unknown version id", () => {
  const rows = environmentRows(
    [
      { environmentId: "4", name: "NoVersion", type: "user" },
      { environmentId: "5", name: "Unknown", type: "user", containerVersionId: "99" },
    ], []);
  expect(rows[0]!.version_id).toBe("latest");
  expect(rows[1]!.version_id).toBe("99");
  expect(rows[1]!.version_name).toBe("");
});

test("versionRows sorts newest-first by numeric id and applies the limit", () => {
  const headers = [
    { containerVersionId: "9", name: "nine" },
    { containerVersionId: "10", name: "ten" },
    { containerVersionId: "41", name: "forty-one", numTags: "7", numTriggers: "3", numVariables: "5", deleted: true },
  ];
  expect(versionRows(headers, 2).map((r) => r.version_id)).toEqual(["41", "10"]);
  expect(versionRows(headers, 2)[0]).toEqual({
    version_id: "41", name: "forty-one", deleted: true,
    num_tags: "7", num_triggers: "3", num_variables: "5",
  });
  expect(versionRows(headers, 99).map((r) => r.version_id)).toEqual(["41", "10", "9"]);
});

test("versionRows fills missing optional header fields with empty strings", () => {
  expect(versionRows([{ containerVersionId: "1" }], 10)[0]).toEqual({
    version_id: "1", name: "", deleted: false, num_tags: "", num_triggers: "", num_variables: "",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/versionInfo.test.ts`
Expected: FAIL — `Cannot find module './versionInfo.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/commands/versionInfo.ts`:

```ts
import type { Cmd } from "../command.ts";
import type { GtmEnvironment, GtmVersionHeader } from "../gtm/types.ts";
import { configPath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { parseContainerRef } from "../config/ref.ts";
import { getUserToken } from "../auth/token.ts";
import { GtmClient } from "../gtm/client.ts";
import { resolveAlias } from "./_shared.ts";
import { format } from "../output.ts";

const ENV_COLUMNS = ["name", "type", "environment_id", "version_id", "version_name"];
const VERSION_COLUMNS = ["version_id", "name", "deleted", "num_tags", "num_triggers", "num_variables"];
const DEFAULT_LIMIT = 20;

export interface EnvironmentRow {
  name: string; type: string; environment_id: string; version_id: string; version_name: string;
}
export interface VersionRow {
  version_id: string; name: string; deleted: boolean;
  num_tags: string; num_triggers: string; num_variables: string;
}

// An empty or "0" containerVersionId means the environment auto-tracks the
// newest publish rather than pinning a specific version.
export function environmentRows(envs: GtmEnvironment[], headers: GtmVersionHeader[]): EnvironmentRow[] {
  const nameById = new Map(headers.map((h) => [h.containerVersionId, h.name ?? ""]));
  return envs.map((e) => {
    const pinned = e.containerVersionId && e.containerVersionId !== "0" ? e.containerVersionId : null;
    return {
      name: e.name, type: e.type, environment_id: e.environmentId,
      version_id: pinned ?? "latest",
      version_name: pinned ? (nameById.get(pinned) ?? "") : "(tracks newest publish)",
    };
  });
}

export function versionRows(headers: GtmVersionHeader[], limit: number): VersionRow[] {
  return headers
    .slice()
    .sort((a, b) => Number(b.containerVersionId) - Number(a.containerVersionId))
    .slice(0, limit)
    .map((h) => ({
      version_id: h.containerVersionId, name: h.name ?? "", deleted: !!h.deleted,
      num_tags: h.numTags ?? "", num_triggers: h.numTriggers ?? "", num_variables: h.numVariables ?? "",
    }));
}

// Both commands take a container ref only to locate the account/container; any
// @snapshot suffix is irrelevant here and is discarded after validation.
async function containerAndClient(flags: Record<string, unknown>) {
  const { alias } = parseContainerRef(await resolveAlias(flags));
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  return { r, client: new GtmClient(await getUserToken(cfg)) };
}

// gallium environments [-c <ref>]
export const cmdEnvironments: Cmd = async (_positionals, flags) => {
  const { r, client } = await containerAndClient(flags);
  const [envs, headers] = await Promise.all([
    client.listEnvironments(r.accountId, r.containerId),
    client.listVersionHeaders(r.accountId, r.containerId),
  ]);
  console.log(format(environmentRows(envs, headers), { json: !!flags.json, columns: ENV_COLUMNS }));
  return 0;
};

// gallium versions [-c <ref>] [--limit N]
export const cmdVersions: Cmd = async (_positionals, flags) => {
  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer; got '${flags.limit}'`);
  }
  const { r, client } = await containerAndClient(flags);
  const headers = await client.listVersionHeaders(r.accountId, r.containerId);
  console.log(format(versionRows(headers, limit), { json: !!flags.json, columns: VERSION_COLUMNS }));
  return 0;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/versionInfo.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Register the commands**

In `src/cli.ts`:

1. Add the import after the `cmdSkillInstall` import:
   ```ts
   import { cmdEnvironments, cmdVersions } from "./commands/versionInfo.ts";
   ```
2. Add to the `FLAT` table, on the discovery line:
   ```ts
   accounts: cmdAccounts, containers: cmdContainers, workspaces: cmdWorkspaces,
   environments: cmdEnvironments, versions: cmdVersions,
   ```
3. Add to `OPTIONS`, after `container`:
   ```ts
   limit: { type: "string" },
   ```

- [ ] **Step 6: Verify the commands are routable**

Append to `src/cli.test.ts`:

```ts
test("environments and versions are registered commands", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { await run(["--help"]); } finally { console.log = orig; }
  expect(out).toContain("environments");
  expect(out).toContain("versions");
});
```

Run: `bun test src/cli.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/commands/versionInfo.ts src/commands/versionInfo.test.ts src/cli.ts src/cli.test.ts
git commit -m "feat(cli): add 'gallium environments' and 'gallium versions'"
```

---

### Task 6: Snapshot resolution, auto-pull, and `@ref` everywhere

Resolves a `SnapshotRef` to a concrete version id, pulls that snapshot if it isn't cached, and routes every analysis command through it. After this task, `-c acme/web@v42` works on `list`, `show`, `refs`, `tag`, `trigger`, and `code search`.

**Files:**
- Create: `src/commands/_snapshot.ts`
- Create: `src/commands/_snapshot.test.ts`
- Modify: `src/commands/_shared.ts` (add `openTarget`)
- Modify: `src/commands/list.ts`, `entity.ts`, `refs.ts`, `code.ts` (swap `openPulled(await resolveAlias(flags))` → `openTarget(flags)`)
- Modify: `src/commands/versionInfo.ts` (add `cmdVersion`)
- Modify: `src/cli.ts` (register `version`)

**Interfaces:**
- Consumes: `SnapshotRef`, `parseContainerRef`, `parseAgainst`, `describeSnapshot` (Task 1); `GtmClient` methods (Task 3); `pullVersion`, `openVersionDb` (Task 4).
- Produces:
  - `resolveSnapshotVersionId(client, accountId, containerId, snap: SnapshotRef): Promise<string>`
  - `openSnapshot(alias: string, snap: SnapshotRef): Promise<{ db: Database; versionId: string; versionName: string }>` — auto-pulls if absent
  - `openTarget(flags): Promise<Database>` from `./_shared.ts` — the single entry point analysis commands use
  - `cmdVersion: Cmd`

- [ ] **Step 1: Write the failing test**

Create `src/commands/_snapshot.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolveSnapshotVersionId } from "./_snapshot.ts";

const client = {
  getLiveVersion: async () => ({ containerVersionId: "42" }),
  getLatestVersionHeader: async () => ({ containerVersionId: "43" }),
  listEnvironments: async () => [
    { environmentId: "1", name: "Live", type: "live", containerVersionId: "42" },
    { environmentId: "3", name: "Dev", type: "user", containerVersionId: "41" },
    { environmentId: "2", name: "Latest", type: "latest", containerVersionId: "0" },
  ],
} as any;

test("an explicit version id resolves to itself without any API call", async () => {
  const exploding = { getLiveVersion: () => { throw new Error("should not be called"); } } as any;
  expect(await resolveSnapshotVersionId(exploding, "1", "2", { kind: "version", id: "42" })).toBe("42");
});

test("live and latest resolve via their dedicated endpoints", async () => {
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "live" })).toBe("42");
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "latest" })).toBe("43");
});

test("env resolves by case-insensitive name to the version it points at", async () => {
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "dev" })).toBe("41");
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "Dev" })).toBe("41");
});

test("an unpinned env falls through to the latest version", async () => {
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "Latest" })).toBe("43");
});

test("an unknown env name errors and lists what is available", async () => {
  await expect(resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "staging" }))
    .rejects.toThrow(/Live, Dev, Latest/);
});

test("a container with no published version gives an actionable error", async () => {
  const empty = { getLiveVersion: async () => ({}), getLatestVersionHeader: async () => ({}) } as any;
  await expect(resolveSnapshotVersionId(empty, "1", "2", { kind: "live" })).rejects.toThrow(/no live/i);
  await expect(resolveSnapshotVersionId(empty, "1", "2", { kind: "latest" })).rejects.toThrow(/no versions/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/_snapshot.test.ts`
Expected: FAIL — `Cannot find module './_snapshot.ts'`

- [ ] **Step 3: Write `_snapshot.ts`**

Create `src/commands/_snapshot.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { SnapshotRef } from "../config/ref.ts";
import { configPath, versionDbPath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { getUserToken } from "../auth/token.ts";
import { GtmClient } from "../gtm/client.ts";
import { openVersionDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { pullVersion } from "../pull/pull.ts";

// Named refs (@live/@latest/env:) resolve to a concrete id *before* a cache path
// is chosen, so they always follow the newest publish instead of going stale.
export async function resolveSnapshotVersionId(
  client: GtmClient, accountId: string, containerId: string, snap: SnapshotRef,
): Promise<string> {
  switch (snap.kind) {
    case "version":
      return snap.id;
    case "live": {
      const v = await client.getLiveVersion(accountId, containerId);
      if (!v.containerVersionId) throw new Error("Container has no live (published) version.");
      return v.containerVersionId;
    }
    case "latest": {
      const h = await client.getLatestVersionHeader(accountId, containerId);
      if (!h.containerVersionId) throw new Error("Container has no versions yet.");
      return h.containerVersionId;
    }
    case "env": {
      const envs = await client.listEnvironments(accountId, containerId);
      const match = envs.find((e) => e.name.toLowerCase() === snap.name.toLowerCase());
      if (!match) {
        const available = envs.map((e) => e.name).join(", ") || "(none)";
        throw new Error(`No environment named '${snap.name}'. Available: ${available}`);
      }
      if (!match.containerVersionId || match.containerVersionId === "0") {
        const h = await client.getLatestVersionHeader(accountId, containerId);
        if (!h.containerVersionId) {
          throw new Error(`Environment '${match.name}' tracks the latest version, but the container has no versions yet.`);
        }
        return h.containerVersionId;
      }
      return match.containerVersionId;
    }
  }
}

export interface OpenedSnapshot {
  db: Database; versionId: string; versionName: string;
}

// Versions are immutable, so a cached snapshot is never stale and is pulled at
// most once, ever.
export async function openSnapshot(alias: string, snap: SnapshotRef): Promise<OpenedSnapshot> {
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  const client = new GtmClient(await getUserToken(cfg));
  const versionId = await resolveSnapshotVersionId(client, r.accountId, r.containerId, snap);

  const db = await openVersionDb(alias, versionId);
  if (!getMeta(db, "last_pulled_at")) {
    await pullVersion(db, client, r.accountId, r.containerId, versionId, new Date().toISOString());
  }
  return { db, versionId, versionName: getMeta(db, "version_name") ?? "" };
}

export function snapshotDbPath(alias: string, versionId: string): string {
  return versionDbPath(alias, versionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/_snapshot.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Add `openTarget` to `_shared.ts`**

Append to `src/commands/_shared.ts` (and add the two imports at the top: `import { parseContainerRef } from "../config/ref.ts";` and `import { openSnapshot } from "./_snapshot.ts";`):

```ts
// The single entry point for analysis commands: resolves -c to either the
// workspace DB or an auto-pulled version snapshot.
export async function openTarget(flags: Record<string, unknown>): Promise<Database> {
  const ref = parseContainerRef(await resolveAlias(flags));
  if (!ref.snapshot) return openPulled(ref.alias);
  return (await openSnapshot(ref.alias, ref.snapshot)).db;
}
```

- [ ] **Step 6: Route the analysis commands through it**

In each of these files, change the import from `{ resolveAlias, openPulled }` to `{ openTarget }` (keeping `resolveAlias`/`openPulled` only where still used) and replace `const db = await openPulled(await resolveAlias(flags));` with `const db = await openTarget(flags);`:

- `src/commands/list.ts:15`
- `src/commands/entity.ts:10` (`cmdShow`), `:33` (`cmdTag`), `:45` (`cmdTrigger`)
- `src/commands/refs.ts:10`
- `src/commands/code.ts:10`

Leave `src/commands/diff.ts` alone — Task 8 rewrites it.

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS. Existing `commands.test.ts` tests still pass because a bare alias routes to `openPulled` exactly as before.

- [ ] **Step 8: Write the failing test for admin-command ref rejection**

Config and admin commands operate on configured containers, not snapshots. `container pull acme/web@v42`
must not silently pull the workspace, and `container use acme/web@v42` must not write a bogus default.

Append to `src/commands/commands.test.ts`:

```ts
test("container commands reject a snapshot ref instead of silently ignoring it", async () => {
  const cfgDir = join(dir, "gallium");
  mkdirSync(cfgDir, { recursive: true });
  await Bun.write(join(cfgDir, "config.toml"), `[oauth]\nclient_id = "id"\nclient_secret = "s"\n`);
  await cmdContainerAdd(["acme/web", "111", "222", "3"], {});

  await expect(cmdContainerUse(["acme/web@v42"], {})).rejects.toThrow(/not a snapshot|snapshot ref/i);
  await expect(cmdContainerPull(["acme/web@live"], {})).rejects.toThrow(/not a snapshot|snapshot ref/i);
  await expect(cmdContainerShow([], { container: "acme/web@v42" })).rejects.toThrow(/not a snapshot|snapshot ref/i);
});
```

Add `cmdContainerUse, cmdContainerPull, cmdContainerShow` to the existing `./container.ts` import.

Run: `bun test src/commands/commands.test.ts`
Expected: FAIL — these currently throw `Unknown container alias 'acme/web@v42'`, not the guard message

- [ ] **Step 9: Add the guard and apply it**

Append to `src/commands/_shared.ts`:

```ts
// Config and admin commands act on a configured container, not a point-in-time
// snapshot. Reject an @ref rather than quietly dropping the suffix.
export function requireWorkspaceAlias(raw: string): string {
  const ref = parseContainerRef(raw);
  if (ref.snapshot) {
    throw new Error(`'${raw}' is a snapshot ref; this command takes a container alias (e.g. '${ref.alias}').`);
  }
  return ref.alias;
}
```

In `src/commands/container.ts`, import it (`import { resolveAlias, requireWorkspaceAlias } from "./_shared.ts";`) and wrap each place an alias is taken:

- `cmdContainerUse`: `const alias = requireWorkspaceAlias(positionals[0] ?? "");` — keep the existing
  `if (!alias)` usage error *before* the guard by checking `positionals[0]` first.
- `cmdContainerShow`: `const alias = requireWorkspaceAlias(await resolveAlias(flags));`
- `cmdContainerStatus`: same as `cmdContainerShow`.
- `cmdContainerPull`: `const alias = requireWorkspaceAlias(positionals[0] ?? await resolveAlias(flags));`
- `cmdContainerAdd`: guard the `alias` positional with `requireWorkspaceAlias(alias)` after the usage check.

Run: `bun test src/commands/commands.test.ts`
Expected: PASS

- [ ] **Step 10: Add `gallium version <id>`**

Append to `src/commands/versionInfo.ts` (adding imports `parseAgainst, describeSnapshot` from `../config/ref.ts`, `openSnapshot, snapshotDbPath` from `./_snapshot.ts`, and `listEntities` from `../cache/repo.ts`):

```ts
// gallium version <versionId|env:name|live|latest> [-c <ref>]
// Prefetches a snapshot and prints what it resolved to. Analysis commands
// auto-pull too, so this exists for explicit prefetch and for stating the
// resolved target before answering a question.
export const cmdVersion: Cmd = async (positionals, flags) => {
  const target = positionals[0];
  if (!target) throw new Error("usage: gallium version <versionId|env:name|live|latest> [-c <alias>]");
  const snap = parseAgainst(target);
  const { alias } = parseContainerRef(await resolveAlias(flags));
  const { db, versionId, versionName } = await openSnapshot(alias, snap);
  console.log(format({
    alias,
    resolved_from: describeSnapshot(snap),
    version_id: versionId,
    version_name: versionName,
    num_tags: listEntities(db, "tag").length,
    num_triggers: listEntities(db, "trigger").length,
    num_variables: listEntities(db, "variable").length,
    db_path: snapshotDbPath(alias, versionId),
  }, { json: !!flags.json }));
  return 0;
};
```

- [ ] **Step 11: Register it**

In `src/cli.ts`, add `cmdVersion` to the `versionInfo.ts` import and to `FLAT`:

```ts
environments: cmdEnvironments, versions: cmdVersions, version: cmdVersion,
```

`--version`/`-v` is matched in `run()` before command dispatch, so the bare `version` command does not shadow the flag.

- [ ] **Step 12: Verify flag and command coexist**

Append to `src/cli.test.ts`:

```ts
test("--version still prints the CLI version despite the 'version' command", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { expect(await run(["--version"])).toBe(0); } finally { console.log = orig; }
  expect(out).toMatch(/^\d+\.\d+\.\d+/);
});
```

Run: `bun test`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/commands/_snapshot.ts src/commands/_snapshot.test.ts src/commands/_shared.ts \
        src/commands/list.ts src/commands/entity.ts src/commands/refs.ts src/commands/code.ts \
        src/commands/container.ts src/commands/commands.test.ts \
        src/commands/versionInfo.ts src/cli.ts src/cli.test.ts
git commit -m "feat(snapshot): resolve @refs, auto-pull versions, add 'gallium version'"
```

---

### Task 7: Entity-set comparison

The local version-vs-version diff the GTM API doesn't provide. Pure function over two databases, so it is fully testable in memory.

**Files:**
- Create: `src/pull/compare.ts`
- Create: `src/pull/compare.test.ts`

**Interfaces:**
- Consumes: `allEntityHashes` from `src/cache/repo.ts` (Task 4).
- Produces:
  - `interface DiffRow { change_status: string; kind: string; name: string; id: string }`
  - `compareSnapshots(left: Database, right: Database): DiffRow[]` — `left` is the "new" side, `right` the baseline

- [ ] **Step 1: Write the failing test**

Create `src/pull/compare.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDbAt } from "../cache/db.ts";
import { upsertEntity } from "../cache/repo.ts";
import { compareSnapshots } from "./compare.ts";

function dbWith(entities: { id: string; kind: string; name: string; raw: unknown }[]) {
  const db = openDbAt(":memory:");
  for (const e of entities) {
    upsertEntity(db, { id: e.id, kind: e.kind, name: e.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(e.raw), searchText: "" });
  }
  return db;
}

test("identical content with different location fields produces an empty diff", () => {
  const ws = dbWith([{ id: "10", kind: "tag", name: "GA4", raw: {
    tagId: "10", name: "GA4", fingerprint: "aaa", workspaceId: "3",
    path: "accounts/1/containers/2/workspaces/3/tags/10" } }]);
  const ver = dbWith([{ id: "10", kind: "tag", name: "GA4", raw: {
    tagId: "10", name: "GA4", fingerprint: "zzz", containerVersionId: "42",
    path: "accounts/1/containers/2/versions/42/tags/10" } }]);
  expect(compareSnapshots(ws, ver)).toEqual([]);
});

test("classifies added, updated, and deleted", () => {
  const left = dbWith([
    { id: "10", kind: "tag", name: "Changed", raw: { tagId: "10", name: "Changed", paused: true } },
    { id: "11", kind: "tag", name: "New Tag", raw: { tagId: "11", name: "New Tag" } },
    { id: "12", kind: "tag", name: "Same", raw: { tagId: "12", name: "Same" } },
  ]);
  const right = dbWith([
    { id: "10", kind: "tag", name: "Changed", raw: { tagId: "10", name: "Changed", paused: false } },
    { id: "12", kind: "tag", name: "Same", raw: { tagId: "12", name: "Same" } },
    { id: "13", kind: "tag", name: "Removed Tag", raw: { tagId: "13", name: "Removed Tag" } },
  ]);
  expect(compareSnapshots(left, right)).toEqual([
    { change_status: "added", kind: "tag", name: "New Tag", id: "11" },
    { change_status: "deleted", kind: "tag", name: "Removed Tag", id: "13" },
    { change_status: "updated", kind: "tag", name: "Changed", id: "10" },
  ]);
});

test("the same id in different kinds is not confused", () => {
  const left = dbWith([
    { id: "1", kind: "tag", name: "T", raw: { a: 1 } },
    { id: "1", kind: "trigger", name: "G", raw: { a: 1 } },
  ]);
  const right = dbWith([{ id: "1", kind: "tag", name: "T", raw: { a: 1 } }]);
  expect(compareSnapshots(left, right)).toEqual([
    { change_status: "added", kind: "trigger", name: "G", id: "1" },
  ]);
});

test("a deleted row reports the name from the baseline side", () => {
  const left = dbWith([]);
  const right = dbWith([{ id: "9", kind: "variable", name: "Old Var", raw: { a: 1 } }]);
  expect(compareSnapshots(left, right)).toEqual([
    { change_status: "deleted", kind: "variable", name: "Old Var", id: "9" },
  ]);
});

test("two empty snapshots compare clean", () => {
  expect(compareSnapshots(dbWith([]), dbWith([]))).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/pull/compare.test.ts`
Expected: FAIL — `Cannot find module './compare.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/pull/compare.ts`:

```ts
import type { Database } from "bun:sqlite";
import { allEntityHashes } from "../cache/repo.ts";

export interface DiffRow {
  change_status: string; kind: string; name: string; id: string;
}

// GTM has no version-vs-version diff API, so classify locally. `left` is the
// side being judged (workspace or newer version); `right` is the baseline.
// Entity ids survive publishing, so (kind, id) is the join key.
export function compareSnapshots(left: Database, right: Database): DiffRow[] {
  const key = (kind: string, id: string) => `${kind} ${id}`;
  const baseline = new Map(allEntityHashes(right).map((e) => [key(e.kind, e.id), e]));
  const rows: DiffRow[] = [];

  for (const e of allEntityHashes(left)) {
    const k = key(e.kind, e.id);
    const other = baseline.get(k);
    if (!other) {
      rows.push({ change_status: "added", kind: e.kind, name: e.name, id: e.id });
    } else if (other.content_hash !== e.content_hash) {
      rows.push({ change_status: "updated", kind: e.kind, name: e.name, id: e.id });
    }
    baseline.delete(k);
  }
  // Whatever is left in the baseline exists only there.
  for (const e of baseline.values()) {
    rows.push({ change_status: "deleted", kind: e.kind, name: e.name, id: e.id });
  }

  return rows.sort((a, b) =>
    a.change_status.localeCompare(b.change_status) ||
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/pull/compare.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pull/compare.ts src/pull/compare.test.ts
git commit -m "feat(compare): classify added/updated/deleted between two entity sets"
```

---

### Task 8: `gallium diff --against`

Wires the comparison to the CLI. Without `--against`, output is unchanged from today.

**Files:**
- Modify: `src/commands/diff.ts`
- Modify: `src/cli.ts` (add `--against`)
- Modify: `src/commands/commands.test.ts` (append tests)

**Interfaces:**
- Consumes: `parseContainerRef`, `parseAgainst`, `describeSnapshot` (Task 1); `openTarget` (Task 6); `openSnapshot` (Task 6); `compareSnapshots` (Task 7).
- Produces: updated `cmdDiff`. `cmdDirty` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/commands/commands.test.ts` (add `cmdDiff` to the existing `./diff.ts` import):

```ts
test("cmdDiff without --against still reads the API-derived changes table", async () => {
  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-06-19T00:00:00Z");
  recordChange(db, "tag", "10", "GA4 Event", "updated");
  await saveState(statePath(), { default_container: "acme/web" });
  expect(await cmdDiff([], { json: true })).toBe(0);
  expect(JSON.parse(logs.join("\n"))).toEqual([
    { change_status: "updated", kind: "tag", name: "GA4 Event", id: "10" },
  ]);
});

test("cmdDiff on a version ref without --against errors instead of printing nothing", async () => {
  await saveState(statePath(), { default_container: "acme/web" });
  await expect(cmdDiff([], { json: true, container: "acme/web@v42" })).rejects.toThrow(/--against/);
});

test("cmdDiff rejects an invalid --against target before touching the network", async () => {
  await saveState(statePath(), { default_container: "acme/web" });
  await expect(cmdDiff([], { json: true, against: "nonsense" })).rejects.toThrow(/Valid forms/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/commands.test.ts`
Expected: FAIL — the version-ref test throws `Unknown container alias 'acme/web@v42'` rather than the `--against` message

- [ ] **Step 3: Rewrite `diff.ts`**

Replace `src/commands/diff.ts` with:

```ts
import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled, openTarget } from "./_shared.ts";
import { openSnapshot } from "./_snapshot.ts";
import { parseContainerRef, parseAgainst, describeSnapshot } from "../config/ref.ts";
import { compareSnapshots } from "../pull/compare.ts";
import { pendingChanges, listEntities } from "../cache/repo.ts";
import { format } from "../output.ts";

const COLUMNS = ["change_status", "kind", "name", "id"];

// gallium diff [--against <versionId|env:name|live|latest>]
// Without --against: the GTM API's own workspace status (pending vs live).
// With --against: a local comparison of two entity sets by content hash.
export const cmdDiff: Cmd = async (_positionals, flags) => {
  const raw = await resolveAlias(flags);
  const ref = parseContainerRef(raw);
  const against = flags.against as string | undefined;
  const status = flags.status as string | undefined;

  if (!against) {
    if (ref.snapshot) {
      throw new Error(
        `'diff' without --against compares a workspace against live, but '${raw}' is a version snapshot. ` +
        `Pass --against <versionId|env:name|live|latest>.`,
      );
    }
    const db = await openPulled(ref.alias);
    console.log(format(pendingChanges(db, { status }), { json: !!flags.json, columns: COLUMNS }));
    return 0;
  }

  // Parsed before any network call so bad input fails fast.
  const target = parseAgainst(against);
  const left = await openTarget(flags);
  const right = await openSnapshot(ref.alias, target);
  const rows = compareSnapshots(left, right.db)
    .filter((r) => !status || r.change_status === status);
  if (!flags.json) {
    console.error(`# comparing ${raw} against ${describeSnapshot(target)} (version ${right.versionId})`);
  }
  console.log(format(rows, { json: !!flags.json, columns: COLUMNS }));
  return 0;
};

// gallium dirty — pending changes PLUS paused entities (tags).
export const cmdDirty: Cmd = async (_positionals, flags) => {
  const db = await openTarget(flags);
  const changes = pendingChanges(db, { status: flags.status as string | undefined });
  const paused = listEntities(db, "tag", { pausedOnly: true })
    .map((e) => ({ change_status: "paused", kind: e.kind, name: e.name, id: e.id }));
  console.log(format([...changes, ...paused], { json: !!flags.json, columns: COLUMNS }));
  return 0;
};
```

The resolved-target line goes to `stderr` so `--json` output stays machine-parseable and the human form still states what it compared — the preflight-parity rule from the spec.

- [ ] **Step 4: Register `--against`**

In `src/cli.ts`, add to `OPTIONS` after `limit`:

```ts
  against: { type: "string" },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/commands/commands.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/diff.ts src/commands/commands.test.ts src/cli.ts
git commit -m "feat(diff): add --against to compare a workspace or version against any snapshot"
```

---

### Task 9: Skill and documentation

The CLI is useless to the agent until the skill knows these commands exist and when to reach for them.

**Files:**
- Modify: `src/skill/SKILL.md`
- Modify: `src/skill/references/gtm-concepts.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished command surface from Tasks 5, 6, 8.
- Produces: no code.

- [ ] **Step 1: Confirm the real command surface before documenting it**

Run: `bun run bin/gallium.ts --help`
Expected: the command list includes `environments`, `versions`, `version`.

Documenting commands that don't match the built binary is the main failure mode of this task — read the actual `FLAT`/`OPTIONS` tables in `src/cli.ts` and the usage strings in the command files rather than copying from this plan.

- [ ] **Step 2: Extend the preflight section of `SKILL.md`**

In `## Preflight (always)`, append to Step 1's final bullet (the one beginning "When you've picked a container"):

```markdown
- When a question concerns a **version or environment** rather than the workspace, also state the
  **environment name and the version id it resolved to** before answering (`gallium environments --json`
  shows both). A wrong-target mismatch — reading Dev when the user meant Live — must surface the same
  way a wrong-container mismatch does.
```

Append to Step 2:

```markdown
- Version snapshots (`-c <alias>@v42`, `@live`, `@latest`) are **immutable and cached forever** — the
  staleness rule above does not apply to them, and they are fetched automatically on first use. Only the
  *workspace* needs a freshness check.
```

- [ ] **Step 3: Add the command table to `SKILL.md`**

Insert a new section after `### Analysis`:

```markdown
### Versions & environments

| User asks | Command |
|---|---|
| What version is published to Dev / Live? | `gallium environments --json` |
| What versions exist? | `gallium versions [--limit N] --json` |
| Details of version N (name, notes, counts) | `gallium version N --json` |
| Does my workspace match what's on Dev? | `gallium diff --against env:dev --json` |
| What changed between two publishes? | `gallium diff -c <alias>@v41 --against 42 --json` |
| Inspect the config of a published version | any analysis command with `-c <alias>@v42` |

Any container ref accepts an `@` suffix naming an immutable snapshot: `@v42`, `@live` (newest published),
`@latest` (newest version, published or not). So `gallium list tags -c acme/web@live --json` lists the
tags as actually published, and `gallium show 'My Tag' -c acme/web@v42` shows that tag's config in
version 42. `--against` additionally accepts `env:<name>`.
```

- [ ] **Step 4: Extend the interpretation notes in `SKILL.md`**

Append to `## Interpreting results`:

```markdown
- `diff --against` is computed **locally** by comparing entity content, not by the GTM API. An empty
  result is a positive assurance that the two sides match. It ignores storage bookkeeping (`fingerprint`,
  `path`, workspace/version ids) and treats everything else as content — so an unexpected `updated` row
  with no visible difference means a field gallium doesn't model changed; use `gallium show` on both
  sides to see it.
- An environment whose `version_id` reads `latest` is not pinned — it auto-tracks the newest publish.
```

- [ ] **Step 5: Add the concepts section**

Append to `src/skill/references/gtm-concepts.md`:

```markdown
## Workspace vs. version vs. environment

Three distinct things, routinely confused:

- **Workspace** — a mutable, per-user editing area. Changes live here until published. `gallium diff`
  with no arguments shows what a workspace has that the live version doesn't.
- **Version** — an immutable numbered snapshot created by publishing. Never changes once created, which
  is why gallium caches version snapshots forever with no freshness check.
- **Environment** — a *named pointer* at a version, with its own snippet/auth code. `Live` points at the
  published production version; `Latest` auto-tracks the newest version; user-defined ones (Dev, Staging)
  point wherever they were last published to.

The consequence that matters: "published" is ambiguous. Work can be published to a **Dev environment**
without being live in production. A workspace can therefore show changes as pending relative to *live*
while being byte-identical to what's deployed on *Dev*. `gallium diff --against env:dev` is what settles
it; `gallium diff` alone cannot.

Pinning: `@v42` is fixed forever. `@live` and `@latest` re-resolve on every invocation and will follow a
new publish.
```

- [ ] **Step 6: Update `README.md`**

Three edits, matching the file's existing structure (`## Commands` uses commented shell blocks; `##
Question → command reference` uses tables; `## Flags` is a table).

**(a)** Add a new `### Versions & environments` subsection under `## Commands`, immediately after
`### Analysis commands` (currently around line 143–177):

````markdown
### Versions & environments

```bash
# Every environment and the version it currently points at.
gallium environments

# Published versions, newest first.
gallium versions --limit 10

# Prefetch a version snapshot and print its name, notes, and entity counts.
gallium version 42
gallium version env:dev

# Compare against something other than live. Empty output means they match.
gallium diff --against env:dev
gallium diff --against 42
gallium diff -c acme/web@v41 --against 42
```

Any `-c` value accepts an `@` suffix naming an immutable snapshot — `@v42`, `@live` (newest published),
or `@latest` (newest version, published or not) — and every analysis command honours it:

```bash
gallium list tags -c acme/web@live
gallium show 'My Tag' -c acme/web@v42
```

Snapshots are fetched automatically on first use and cached permanently, since a version never changes.
````

**(b)** Add a table under `## Question → command reference`, after the `### Analysis` table (line ~231):

```markdown
### Versions & environments

| User asks | Command |
|---|---|
| What version is published to Dev / Live? | `gallium environments --json` |
| What versions exist? | `gallium versions [--limit N] --json` |
| Details of version N | `gallium version N --json` |
| Does my workspace match what's on Dev? | `gallium diff --against env:dev --json` |
| What changed between two publishes? | `gallium diff -c <alias>@v41 --against 42 --json` |
| Inspect a published version's config | any analysis command with `-c <alias>@v42` |
```

**(c)** Add two rows to the `## Flags` table:

```markdown
| `--against <target>` | | Diff against `<versionId>`, `env:<name>`, `live`, or `latest` |
| `--limit <n>` | | Max rows for `gallium versions` (default 20) |
```

**(d)** Add a release note near the top of `## Install`:

```markdown
> **Upgrading to the version-inspection release:** the local cache schema changed, so existing caches are
> discarded on first use. Run `gallium container pull <alias>` once per container. No config or auth
> changes are needed.
```

- [ ] **Step 7: Verify the documented commands actually run**

Run each and confirm the usage/error text matches what's documented (network calls will fail without credentials — that's fine; you're checking that the commands are wired and the argument validation messages match):

```bash
bun run bin/gallium.ts --help
bun run bin/gallium.ts version          # expect the usage error
bun run bin/gallium.ts versions --limit 0   # expect "--limit must be a positive integer"
```

- [ ] **Step 8: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/skill/SKILL.md src/skill/references/gtm-concepts.md README.md
git commit -m "docs(skill): teach gallium about versions, environments, and @refs"
```

---

## Acceptance check

After Task 9, against a real container with a Dev environment:

```bash
gallium environments -c honeylove/checkout-cat            # names Dev's containerVersionId
gallium diff --against env:dev -c honeylove/checkout-cat  # must print "(no results)"
```

An empty diff proves the Dev-deployed version matches the reviewed workspace.

**If every entity reports `updated`,** the `(kind, id)` join or the STRIP list is wrong — dump both sides
with `gallium show '<name>' -c <alias>` and `gallium show '<name>' -c <alias>@v<id>` and compare. The most
likely culprit is an unlisted location field; the second most likely is array ordering (`firingTriggerId`
returned in a different order between workspace and version). If it's ordering, the fix is to sort
`firingTriggerId`/`blockingTriggerId` inside `normalizeForHash` — deliberately *not* done up front,
because sorting arrays speculatively can mask real changes.
