# Workspace Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gallium apply <spec.json> -c <alias> --workspace <name|new:Title> [--commit]` creates, patches and deletes tags, triggers, variables and folders in a named workspace, and gallium still cannot publish.

**Architecture:** A pure planner turns spec entries plus an in-memory workspace snapshot into a list of ops; a thin executor sends them through new `GtmClient` write methods. All HTTP goes through one `request()` with a cross-invocation pacer and quota retry. Write access is a login-time opt-in recorded on disk and checked before any commit.

**Tech Stack:** Bun, TypeScript, `node:util` parseArgs, `bun test` with colocated `*.test.ts` and injected `fetchFn`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-write-ops-design.md`

## Global Constraints

- Scopes requested are exactly `https://www.googleapis.com/auth/tagmanager.readonly` and, with `--write`, `https://www.googleapis.com/auth/tagmanager.edit.containers`. Never `tagmanager.publish`, `tagmanager.edit.containerversions`, or any other.
- `GtmClient` gets no method that calls `versions`, `create_version`, `quick_preview`, `:publish`, or writes to `environments`.
- `apply` requires both `-c` and `--workspace`; neither falls back to a default. The alias's pinned `workspace_id` is never used by `apply`.
- Without `--commit`, `apply` sends GET requests only.
- Pacing: at most 20 requests per 100 s window, shared across invocations. Retry: up to 5 attempts on `429` or quota `403`.
- Service-account credentials never write.
- Work on branch `feat/workspace-writes`. Commit style follows the log: `feat(scope): …`, `refactor(scope): …`, `docs: …`.
- Run `bun test` (whole suite) before each commit; it must pass.

## Review Focus

1. A spec `name` that differs from the GTM name only by case, or matches two entities: matches case-insensitively; two matches is an error naming both. (Task 4)
2. Re-running a spec after a partial failure: already-applied entries plan as `unchanged`, nothing is created twice. (Task 4, Task 5)
3. `--workspace` names a workspace that no longer exists, or two share the name: error listing the real workspace names; never falls back to another workspace. (Task 5)
4. The recorded scope says write but Google rejects the token (consent revoked): the permission `403` fails at once with no retries and the message names `gallium login --write`. (Task 1, Task 5)
5. An entity edited in the UI between plan and write: the fingerprint mismatch stops the run and the report lists what was applied and what was not. (Task 5)
6. A malformed spec (not JSON, not an array, unknown `kind`, a trigger-list helper on a non-tag, a missing `valueFile`): one error that names the entry index and the problem, before any request. (Task 4)

## File Structure

| file | responsibility |
|---|---|
| `src/gtm/pace.ts` (new) | `Pacer` interface, file-backed sliding-window pacer, quota-error test |
| `src/gtm/client.ts` | `request()` with pacing and retry; write methods |
| `src/gtm/live.ts` (new) | `liveClient(token)`: the one place a paced client is built for commands |
| `src/auth/oauth.ts`, `src/auth/token.ts`, `src/commands/auth.ts` | scopes, recorded grant, write gate, `login --write` |
| `src/pull/classify.ts`, `src/pull/pull.ts` | extract `entityStrings` and `fetchWorkspaceSnapshot` for reuse |
| `src/apply/spec.ts` (new) | spec types, `loadSpec` |
| `src/apply/plan.ts` (new) | `buildPlan` (pure) |
| `src/apply/execute.ts` (new) | `executePlan` |
| `src/commands/apply.ts` (new) | workspace resolution, dry-run/commit flow, output |
| `src/cli.ts` | `apply` command; `write`, `commit`, `workspace` flags |
| `src/skill/SKILL.md`, `README.md` | docs |

---

### Task 1: Paced, retrying transport

**Files:**
- Create: `src/gtm/pace.ts`, `src/gtm/pace.test.ts`, `src/gtm/live.ts`
- Modify: `src/gtm/client.ts`, `src/gtm/client.test.ts`, `src/paths.ts`, `src/commands/container.ts:98`, `src/commands/discover.ts:10`, `src/commands/_snapshot.ts:58`

**Interfaces:**
- Produces:
  - `interface Pacer { acquire(): Promise<void> }`
  - `filePacer(opts?: { path?: string; limit?: number; windowMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Pacer` — defaults: `path = rateLimitPath()`, `limit = 20`, `windowMs = 100_000`.
  - `isQuotaError(status: number, body: string): boolean`
  - `rateLimitPath(env?): string` in `paths.ts` → `${cacheDir(env)}/.ratelimit.json`
  - `new GtmClient(token, fetchFn = fetch, opts: { pacer?: Pacer; sleep?: (ms: number) => Promise<void> } = {})` — no pacer by default, so existing tests are unaffected.
  - `protected request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<any>` — returns parsed JSON, or `undefined` for an empty body.
  - `liveClient(token: string): GtmClient` in `src/gtm/live.ts` → `new GtmClient(token, fetch, { pacer: filePacer() })`

- [ ] **Step 1: Write failing pacer tests** in `src/gtm/pace.test.ts`, each using a temp `path` and injected `now`/`sleep`:

```ts
test("allows up to the limit without sleeping", async () => { /* limit 3: three acquires, sleep never called */ });
test("sleeps until the oldest entry leaves the window", async () => {
  // limit 2, windowMs 100_000, now fixed at 1_000 for two acquires, then 31_000
  // third acquire calls sleep(70_000)
});
test("a second pacer on the same file sees the first one's requests", async () => { /* shared window */ });
test("a missing or corrupt file is treated as empty", async () => { /* write "not json", acquire resolves */ });
test("isQuotaError", () => {
  expect(isQuotaError(429, "")).toBe(true);
  expect(isQuotaError(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}')).toBe(true);
  expect(isQuotaError(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}')).toBe(true);
  expect(isQuotaError(403, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBe(true);
  expect(isQuotaError(403, "insufficient quota to proceed")).toBe(true);
  expect(isQuotaError(403, '{"error":{"status":"PERMISSION_DENIED","message":"insufficient permissions"}}')).toBe(false);
  expect(isQuotaError(500, "quota")).toBe(false);
});
```

- [ ] **Step 2:** Run `bun test src/gtm/pace.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/gtm/pace.ts` and `rateLimitPath`.** The file holds a JSON array of epoch-ms timestamps; `acquire` drops entries older than `windowMs`, sleeps `oldest + windowMs - now` when at the limit, then appends and writes. `isQuotaError`: `429`, or `403` whose body matches `/rateLimitExceeded|RESOURCE_EXHAUSTED|quota/i`.
- [ ] **Step 4:** Run `bun test src/gtm/pace.test.ts`. Expected: PASS.
- [ ] **Step 5: Write failing client tests** in `src/gtm/client.test.ts`:

```ts
test("every request acquires the pacer first", async () => { /* fake pacer counts; listTags over 2 pages → 2 acquires */ });
test("retries a 429 then succeeds", async () => { /* fetchFn: 429, 429, 200; sleep injected; result returned; 3 fetches */ });
test("honours Retry-After seconds", async () => { /* 429 with Retry-After: 7 → sleep(7000) */ });
test("retries a quota 403", async () => { /* 403 rateLimitExceeded then 200 */ });
test("gives up after 5 attempts", async () => { /* always 429 → rejects /failed \(429\)/; exactly 5 fetches */ });
test("does not retry a permission 403", async () => { /* 403 PERMISSION_DENIED → rejects after 1 fetch */ });
```

- [ ] **Step 6:** Run `bun test src/gtm/client.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 7: Implement `request` in `client.ts`; make `getJson` call it.** Backoff when no `Retry-After`: `min(60_000, 2_000 * 2 ** attempt)` plus up to 1 s jitter. Error text keeps the existing shape with the real method: `GTM ${method} ${path} failed (${status}): ${body}`. Default `sleep` is `Bun.sleep`.
- [ ] **Step 8: Add `src/gtm/live.ts` and switch the three `new GtmClient(token)` call sites to `liveClient(token)`.**
- [ ] **Step 9:** Run `bun test`. Expected: PASS, whole suite.
- [ ] **Step 10: Commit** `feat(client): pace requests and retry quota errors`.

---

### Task 2: Client write methods, and proof there is no publish path

**Files:**
- Modify: `src/gtm/client.ts`, `src/gtm/client.test.ts`, `src/gtm/types.ts`

**Interfaces:**
- Produces, on `GtmClient` (`ws` is a `wsPath(...)` string; `WriteKind = "tag" | "trigger" | "variable" | "folder"`, exported from `types.ts`):
  - `createWorkspace(accountId: string, containerId: string, name: string, description?: string): Promise<GtmWorkspace>` — `POST {containerPath}/workspaces`
  - `createEntity(ws: string, kind: WriteKind, body: object): Promise<any>` — `POST {ws}/{kind}s`
  - `updateEntity(ws: string, kind: WriteKind, id: string, body: object, fingerprint?: string): Promise<any>` — `PUT {ws}/{kind}s/{id}`, `fingerprint` as a query parameter when given
  - `deleteEntity(ws: string, kind: WriteKind, id: string): Promise<void>` — `DELETE {ws}/{kind}s/{id}`
- `types.ts`: add optional `fingerprint?: string` and `path?: string` to `GtmTag`, `GtmTrigger`, `GtmVariable`, `GtmFolder`.

- [ ] **Step 1: Write failing tests** in `client.test.ts`, capturing `(url, init)` from `fetchFn`:

```ts
test("createWorkspace POSTs the name", ...);   // method POST, url ends /accounts/1/containers/2/workspaces, JSON body {name:"X"}, Content-Type application/json
test("createEntity POSTs to the plural path", ...);   // kind "trigger" → {ws}/triggers
test("updateEntity PUTs with the fingerprint query", ...);   // url ends /tags/7?fingerprint=123
test("deleteEntity sends DELETE and tolerates an empty 204 body", ...);
test("the client has no publish, version or environment write path", async () => {
  const src = await Bun.file(new URL("./client.ts", import.meta.url)).text();
  expect(src).not.toMatch(/:publish|create_version|quick_preview|:set_latest|reauthorize/);
  const writes = [...src.matchAll(/request\(\s*"(POST|PUT|DELETE)"[^)]*\)/g)].map((m) => m[0]);
  for (const w of writes) expect(w).not.toMatch(/environments|versions/);
  expect(writes.length).toBe(4);
});
```

- [ ] **Step 2:** Run `bun test src/gtm/client.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement the four methods**, each a single `this.request(...)` call so the guard test's count of 4 holds.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(client): workspace and entity write methods`.

---

### Task 3: Opt-in write login

**Files:**
- Modify: `src/auth/oauth.ts`, `src/auth/token.ts`, `src/commands/auth.ts`, `src/commands/auth.test.ts`, `src/cli.ts` (OPTIONS only)
- Test: `src/auth/token.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `oauth.ts`: `export const TAGMANAGER_EDIT_CONTAINERS_SCOPE = "https://www.googleapis.com/auth/tagmanager.edit.containers"`; `loginOAuth(clientId, clientSecret, scopes: string[]): Promise<{ refreshToken: string; scope: string }>` — `scope` is the token response's `scope` field, falling back to `scopes.join(" ")`.
  - `token.ts`: `oauthScopePath(): string` → `${tokenCachePath("oauth")}.scope`; `assertWriteAllowed(): Promise<void>`
  - `cli.ts` OPTIONS: `write: { type: "boolean", default: false }`, `commit: { type: "boolean", default: false }`, `workspace: { type: "string" }`

- [ ] **Step 1: Write failing tests** (temp `XDG_CACHE_HOME`):

```ts
test("assertWriteAllowed passes when the recorded scope includes edit.containers", ...);
test("assertWriteAllowed rejects a read-only grant", ...);   // rejects /gallium login --write/
test("assertWriteAllowed rejects when there is no scope file", ...);   // an existing pre-upgrade login
test("assertWriteAllowed rejects when there is no OAuth refresh token", ...);   // service-account only: /service account/i
```

In `auth.test.ts`, with `loginOAuth` stubbed the way that file already stubs it:

```ts
test("login requests only the read-only scope", ...);   // scopes === [TAGMANAGER_READONLY_SCOPE]
test("login --write requests read-only plus edit.containers and nothing else", ...);   // exact two-element array
test("login records the granted scope and deletes the cached access token", ...);   // .scope written 0600; tokenCachePath("oauth") no longer exists
```

- [ ] **Step 2:** Run `bun test src/auth src/commands/auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `cmdLogin` reads `flags.write`. Success message for a write login: `Logged in with write access (workspace edits only; gallium cannot publish).` The service-account branch in `getUserToken` keeps `TAGMANAGER_READONLY_SCOPE`.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): opt-in write scope via login --write`.

---

### Task 4: Spec loading and the planner

**Files:**
- Create: `src/apply/spec.ts`, `src/apply/spec.test.ts`, `src/apply/plan.ts`, `src/apply/plan.test.ts`
- Modify: `src/pull/classify.ts`, `src/pull/pull.ts` (extract, no behaviour change)

**Interfaces:**
- Consumes: `EntitySnapshot` from `src/pull/pull.ts`; `WriteKind` from Task 2.
- Produces:
  - `classify.ts`: `entityStrings(kind: "tag" | "trigger" | "variable", e: { parameter?: GtmParameter[]; filter?: GtmCondition[]; customEventFilter?: GtmCondition[]; autoEventFilter?: GtmCondition[] }): string[]` — the per-kind string collection now inline in `ingestEntities`, which is changed to call it.
  - `spec.ts`:

```ts
export interface SpecEntry {
  kind: WriteKind; name: string;
  delete?: boolean; rename?: string; folder?: string;
  firingTriggers?: string[]; blockingTriggers?: string[];
  addFiringTriggers?: string[]; removeFiringTriggers?: string[];
  addBlockingTriggers?: string[]; removeBlockingTriggers?: string[];
  [field: string]: unknown;   // any GTM API field, passed through
}
export async function loadSpec(path: string): Promise<SpecEntry[]>;
```

  - `plan.ts`:

```ts
export interface Op {
  action: "create" | "update" | "delete" | "unchanged";
  kind: WriteKind; name: string;
  id?: string; fingerprint?: string;   // update, delete
  body?: Record<string, unknown>;      // create, update
  changed?: string[];                  // update: top-level API fields that differ
}
export const newRef = (kind: WriteKind, name: string): string => `@new:${kind}:${name.toLowerCase()}`;
export function buildPlan(entries: SpecEntry[], snap: EntitySnapshot): Op[];   // throws PlanError
export class PlanError extends Error { problems: string[] }
```

Planner rules, each pinned by a test below:

- Names match case-insensitively after trimming. The helper keys and `kind`, `delete`, `rename`, `folder` are never copied into a body.
- Patch body = stored entity with each given API field replaced; `rename` sets `name`; `folder` sets `parentFolderId`; trigger-list helpers set `firingTriggerId` / `blockingTriggerId`. Update when the canonical JSON differs from the stored entity, else `unchanged`.
- A reference to an entity the same spec creates becomes `newRef(kind, name)` in the body.
- An entry whose `name` is absent but whose `rename` target exists refers to that entity (so a re-run after a rename is `unchanged`).
- `delete` of an absent entity is `unchanged`.
- Returned order: create/update ops by kind `folder, variable, trigger, tag`, then deletes by kind `tag, trigger, variable, folder`; `unchanged` ops last.
- `{{name}}` references in created and updated entities must resolve to a variable in the post-plan state or an enabled built-in (by `name`); names starting with `_` (e.g. `_event`) are exempt.
- Delete is refused while anything not itself deleted still references the target in the post-plan state: a tag's trigger lists for a trigger, `{{name}}` for a variable, `parentFolderId` for a folder.
- All problems are collected and thrown together as one `PlanError`.

- [ ] **Step 1: Refactor `entityStrings` out of `ingestEntities`.** Run `bun test`. Expected: PASS, unchanged.
- [ ] **Step 2: Commit** `refactor(pull): share per-entity string collection`.
- [ ] **Step 3: Write failing `spec.test.ts`:**

```ts
test("loads an array of entries", ...);
test("replaces valueFile with the file's contents, relative to the spec file, at any parameter depth", ...);   // incl. inside list/map
test("rejects non-JSON, a non-array, an entry without kind or name, an unknown kind", ...);   // message contains "entry 2" for the third entry
test("rejects trigger-list helpers on anything but a tag", ...);
test("rejects delete combined with any other field", ...);
test("rejects a missing valueFile, naming the path", ...);
test("rejects two entries for the same kind and name", ...);
```

- [ ] **Step 4:** Run `bun test src/apply/spec.test.ts`; expected FAIL. Implement `loadSpec`; expected PASS.
- [ ] **Step 5: Write failing `plan.test.ts`** against a small fixture snapshot (tags `GA4 - Purchase` id 10 with `firingTriggerId:["3"]`, `fingerprint:"111"`, and `Ads - Linker` id 11; trigger `All Pages` id 3; variable `JS - GPC Enabled` id 5; folder `Google` id 2; built-in `Page URL`):

```ts
test("creates a trigger that does not exist", ...);          // action create, body has name/type/customEventFilter, no helper keys
test("create without type is an error (folders excepted)", ...);
test("patch replaces only the given top-level fields", ...); // {paused:true} → body equals stored tag + paused; changed ["paused"]; id "10"; fingerprint "111"
test("addBlockingTriggers appends by name and is a no-op when present", ...);
test("blockingTriggers sets the whole list; removeFiringTriggers removes", ...);
test("a trigger created in the same spec is referenced by placeholder", ...);   // blockingTriggerId: ["@new:trigger:block - gpc enabled"]
test("folder resolves to parentFolderId", ...);
test("rename updates the name; re-planning after the rename is unchanged", ...);
test("an identical patch is unchanged", ...);
test("name matching ignores case and surrounding space", ...);
test("two entities with the same name is an error naming both ids", ...);
test("an unresolved trigger, folder or {{variable}} is an error", ...);
test("{{_event}} and enabled built-ins resolve", ...);
test("deleting a trigger still used by a tag is refused", ...);
test("deleting a trigger is allowed when the same spec removes it from every tag", ...);
test("deleting an absent entity is unchanged", ...);
test("orders creates folder→variable→trigger→tag, then deletes in reverse", ...);
test("collects every problem into one PlanError", ...);     // problems.length === 2
test("the bulk shape: one trigger plus N tag patches", ...);   // 1 create + 2 updates, each changed === ["blockingTriggerId"]
```

- [ ] **Step 6:** Run `bun test src/apply/plan.test.ts`. Expected: FAIL.
- [ ] **Step 7: Implement `buildPlan`.** Use `entityStrings` and `extractVariableRefs` for references. For canonical comparison reuse whatever stable serialisation `src/hash.ts` already has; do not strip `fingerprint` from update bodies.
- [ ] **Step 8:** Run `bun test`. Expected: PASS.
- [ ] **Step 9: Commit** `feat(apply): spec loader and pure planner`.

---

### Task 5: The `apply` command

**Files:**
- Create: `src/apply/execute.ts`, `src/apply/execute.test.ts`, `src/commands/apply.ts`, `src/commands/apply.test.ts`
- Modify: `src/pull/pull.ts`, `src/cli.ts`, `src/cli.test.ts`

**Interfaces:**
- Consumes: `buildPlan`, `Op`, `newRef`, `loadSpec`, client write methods, `assertWriteAllowed`, `liveClient`.
- Produces:
  - `pull.ts`: `fetchWorkspaceSnapshot(client: GtmClient, ws: string): Promise<EntitySnapshot>` — the six list calls now inline in `pullWorkspace`, which is changed to call it.
  - `execute.ts`:

```ts
export interface ExecResult { applied: Op[]; failed?: { op: Op; error: string }; pending: Op[]; }
export async function executePlan(ops: Op[], client: GtmClient, ws: string): Promise<ExecResult>;
```

  - `apply.ts`:

```ts
export type WorkspaceTarget =
  | { mode: "existing"; workspaceId: string; name: string }
  | { mode: "new"; name: string };
export function resolveWorkspace(arg: string | undefined, workspaces: GtmWorkspace[]): WorkspaceTarget;
export async function runApply(args: { specPath: string; alias: string; workspace: string | undefined; commit: boolean; json: boolean },
  deps: { client: GtmClient; container: ResolvedContainer; assertWriteAllowed: () => Promise<void> }): Promise<number>;
export const cmdApply: Cmd;   // builds deps from config + liveClient, calls runApply
```

Behaviour:

- `executePlan` skips `unchanged`; for each other op substitutes every `@new:…` string in the body with the id returned by the earlier create (`tagId` / `triggerId` / `variableId` / `folderId`); sends updates with `op.fingerprint`; stops at the first thrown error.
- `resolveWorkspace`: undefined or empty → error `apply requires --workspace <name> or --workspace new:<Title>; it never picks a workspace for you.` `new:Title` → `existing` if a workspace has exactly that name, else `new`. Otherwise exact, case-sensitive name match; zero or more than one match → error listing every workspace as `name (id)`.
- `runApply` order: `requireWorkspaceAlias(alias)`; `loadSpec`; if `commit`, `assertWriteAllowed()`; list workspaces and resolve.
  - Dry-run: snapshot from the existing workspace, or for `mode: "new"` from `getVersion(latest header id)`; `buildPlan`; print; return 0.
  - Commit: create the workspace if `new`; `fetchWorkspaceSnapshot`; `buildPlan`; `executePlan`; then fetch again and `buildPlan` again — every op must be `unchanged`, otherwise report the ones that are not as `not verified`. Return 0 only when nothing failed and all verified.
- When the latest version header id differs from the live version id, print to stderr: `warning: latest version v{latest} is not live (live is v{live}); a new workspace starts from v{latest}.` A failing live lookup is ignored.
- Text output, one line per op: `CREATE trigger "Block - GPC Enabled"`, `UPDATE tag "GA4 - Purchase" (blockingTriggerId)`, `DELETE variable "X"`, `UNCHANGED tag "Y"`. Header line `DRY RUN — nothing sent. Re-run with --commit to apply.` or `APPLIED to workspace "<name>" (<id>)`, then the URL `https://tagmanager.google.com/#/container/accounts/{a}/containers/{c}/workspaces/{w}` and `Not published. Preview and publish in the GTM UI.` On failure: `FAILED <op line>: <error>` followed by `NOT APPLIED` lines for `pending`. A fingerprint/conflict error adds `The entity changed since it was read; re-run to plan against the current state.` A non-quota `403` adds `If write access was revoked, run: gallium login --write`.
- `--json` prints `{ workspace, committed, ops, failed?, pending?, unverified? }` with full request bodies. (Text mode omits bodies; this refines the design doc's "print the request bodies" so a 35-tag plan stays readable.)

- [ ] **Step 1: Refactor `fetchWorkspaceSnapshot` out of `pullWorkspace`.** Run `bun test`; expected PASS. Commit `refactor(pull): expose workspace snapshot fetch`.
- [ ] **Step 2: Write failing `execute.test.ts`** with a recording fake client:

```ts
test("sends creates, updates and deletes in plan order and skips unchanged", ...);
test("substitutes the created id for a placeholder in a later body", ...);   // trigger create returns triggerId "99" → tag PUT body blockingTriggerId ["99"]
test("passes the fingerprint on update", ...);
test("stops at the first failure and reports applied, failed and pending", ...);   // 3 ops, 2nd throws → applied 1, pending 1
```

- [ ] **Step 3:** Run; expected FAIL. Implement `executePlan`; expected PASS.
- [ ] **Step 4: Write failing `apply.test.ts`** using `runApply` with a `GtmClient` built on a routing `fetchFn` that records `(method, url)`:

```ts
test("resolveWorkspace: missing flag is an error", ...);
test("resolveWorkspace: exact name; unknown name lists the real ones; duplicate name is an error", ...);
test("resolveWorkspace: new:Title is new, or existing when already created", ...);
test("an @snapshot ref is rejected", ...);
test("dry run sends only GET requests and does not check write scope", ...);
test("dry run with new:Title plans against the latest version and creates nothing", ...);
test("commit refuses without write scope and sends nothing", ...);   // assertWriteAllowed rejects → rejects; zero requests
test("commit with new:Title creates the workspace, applies, and verifies", ...);   // POST workspaces, POST triggers, PUT tags…; exit 0
test("commit never uses the alias's pinned workspace_id", ...);   // container.workspace_id "999" appears in no URL
test("a mid-apply 409 reports applied and not-applied and exits 1", ...);
test("a permission 403 on write prints the login --write hint and exits 1", ...);
test("a second commit of the same spec is all UNCHANGED and sends no writes", ...);
test("warns when latest is not live", ...);
```

In `cli.test.ts`: `apply` is routed and listed in help; `--commit`, `--workspace`, `--write` parse.

- [ ] **Step 5:** Run `bun test src/commands/apply.test.ts src/cli.test.ts`. Expected: FAIL.
- [ ] **Step 6: Implement `apply.ts` and register `apply: cmdApply` in `FLAT`.** Usage error when the spec path positional is missing: `usage: gallium apply <spec.json> -c <alias> --workspace <name|new:Title> [--commit]`. `-c` must come from the flag: do not call `resolveAlias`.
- [ ] **Step 7:** Run `bun test`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(apply): dry-run-by-default workspace writes`.

---

### Task 6: Documentation

**Files:**
- Modify: `src/skill/SKILL.md`, `README.md`, `src/commands/skill.test.ts`

- [ ] **Step 1: Add a failing assertion** to `skill.test.ts`: the installed `SKILL.md` contains `gallium apply`, `login --write`, and `cannot publish`, and its frontmatter `description` does not contain `read-only`.
- [ ] **Step 2: Rewrite the affected parts of `src/skill/SKILL.md`:**
  - Frontmatter `description`: keep the existing trigger phrases, drop "read-only", add: creating or editing tags, triggers, variables and folders in a named workspace (never publishing).
  - Opening line: reads by default; writes only through `gallium apply`.
  - New `## Writes` section, in this order: (1) gallium cannot publish, create versions or preview — the user does that in the GTM UI; (2) one-time `gallium login --write`, which the user runs themselves; (3) always dry-run first and show the user the plan before `--commit`; (4) `--workspace` is mandatory — use `new:<Title>` for a change set, and never name "Default Workspace" unless the user said to; (5) the spec format table and helper fields from the design doc, with one worked example (a custom-event blocking trigger plus two tags using `addBlockingTriggers`) and a `valueFile` example for a Custom HTML tag; (6) after a commit, give the user the workspace URL and verify with `gallium diff`; (7) the caveat, verbatim: `The write scope also covers the environments API. Gallium has no command for it; do not call it by other means.`
  - `## Interpreting results`: add that every request is paced to 20 per 100 s across invocations, so a long pause is pacing, not a hang.
- [ ] **Step 3: `README.md`:** line 3 no longer says read-only; add a short "Writing" section (opt-in login, `apply`, dry-run, never publishes) linking to the design doc.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: document workspace writes`.

Not in this plan: the release (`package.json` version, tag, and the tap formula's `desc`, `url`, `sha256`). The formula `desc` still says "Read-only" until then.

---

### Task 7: First-use dry run (acceptance, read-only)

**Files (kept outside this repo):**
- Create: one spec file per container (`store.json`, `checkout.json`).

- [ ] **Step 1:** From the built branch (`bun run bin/gallium.ts`), list the target tags at `@live` for each container and select the ones named in the change list. Stop and report if the counts differ from the change list.
- [ ] **Step 2:** Write each spec: one `trigger` entry `Block - GPC Enabled` (`type: "customEvent"`, `customEventFilter` matching `{{_event}}` against `.*` with `matchRegex`, `filter` where `{{JS - GPC Enabled}}` equals `true`), then one `tag` entry per tag with `addBlockingTriggers: ["Block - GPC Enabled"]`.
- [ ] **Step 3:** Dry-run each: `gallium apply store.json -c <store alias> --workspace "new:<title>"`. Expected: `CREATE trigger` once, `UPDATE tag … (blockingTriggerId)` once per listed tag, nothing else, and only GET requests.
- [ ] **Step 4:** Hand over to Charlie: `gallium login --write`, then the same two commands with `--commit`. The commit is his.

The spec files are hand-written inputs, not exports; where they are versioned is Charlie's call.
