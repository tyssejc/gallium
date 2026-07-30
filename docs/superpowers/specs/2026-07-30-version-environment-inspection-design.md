# gallium — version & environment inspection (design)

**Date:** 2026-07-30
**Status:** approved, not started
**Supersedes:** the proposed feature spec scoped 2026-07-23 during the subcategory-Meta-pixel go-live review

---

## Problem

gallium's mental model is only **workspace** and **live** (latest published production version):

- `gallium diff` compares the pulled workspace against the live container version.
- There is no way to answer:
  - "What version is published to the **Dev** (or any) environment?"
  - "Show me the config of container **version N**."
  - "Does my workspace match what's on the **Dev** environment, not prod-live?"

This is a missing *surface*, not a missing capability. The GTM API supports all of it read-only, and
`versions.get` returns the **same entity shape** gallium already ingests from a workspace pull.

The concrete miss: Honeylove's checkout container has category changes published to a Dev environment
version, while the `checkout-cat` workspace still shows them as pending relative to prod-live. We could
verify the workspace was correct; we could not confirm the Dev-deployed version matched it.

---

## Design decisions

Four decisions were settled during brainstorming. They are recorded here with their rationale because
each rules out an approach a future reader would otherwise reach for.

### D1 — Snapshots are addressed by an `@ref` suffix on the container alias

A **container ref** is `<alias>[@<snapshot>]`:

| Ref | Parsed as | DB path |
|---|---|---|
| `hl/checkout-cat` | `{ alias, snapshot: null }` | `~/.cache/gallium/hl/checkout-cat.db` |
| `hl/checkout-cat@v42` | `{ alias, snapshot: { kind: "version", id: "42" } }` | `~/.cache/gallium/hl/checkout-cat@v42.db` |
| `hl/checkout-cat@live` | `{ alias, snapshot: { kind: "named", name: "live" } }` | resolved → `…@v<id>.db` |
| `hl/checkout-cat@latest` | `{ alias, snapshot: { kind: "named", name: "latest" } }` | resolved → `…@v<id>.db` |

Every analysis command (`list`, `show`, `refs`, `tag`, `trigger`, `code search`, `diff`) already routes
through `resolveAlias()` → `openPulled()`. Teaching ref parsing to that one path makes all of them work
against a version snapshot with no per-command changes.

Named refs (`@live`, `@latest`) resolve to a **concrete version id via the API first**, and only then
select a DB path. `@live` is therefore never itself a cache key and cannot go stale — after a publish,
`@live` resolves to the new id and pulls a new snapshot.

Rejected: a `--version` flag (every analysis command needs plumbing, and `-c` stops fully identifying
the data source) and registering versions as config aliases (pollutes `config.toml` with throwaway
entries needing manual cleanup).

### D2 — Equality is a normalized content hash, not `fingerprint`

`fingerprint` is recomputed at storage time, and a version is a fresh stored copy of a workspace's
entities. Workspace-vs-version fingerprints will differ for essentially *every* entity, which would
report total drift and be worse than no diff at all. Raw JSON is equally unusable: workspace entities
carry `workspaceId` and `.../workspaces/752/tags/41` paths while version entities carry
`containerVersionId` and `.../versions/42/tags/41` paths.

The comparison therefore strips a fixed **denylist**, canonicalizes, and hashes:

```
STRIP = path, fingerprint, accountId, containerId,
        workspaceId, containerVersionId, tagManagerUrl

contentHash(raw) = sha256(JSON.stringify(sortKeys(dropStripRecursive(raw))))
```

Everything not on the denylist counts as content — name, type, parameters, trigger wiring, notes,
paused, folder, and any field gallium does not model.

This is deliberately conservative in one direction: a benign new server-side field would read as
`updated` until added to `STRIP`. That is the correct failure mode. The rejected alternative — hashing
an allowlist of fields gallium understands — fails the other way, silently reporting "no drift" when a
real change lands in an unmodeled field. A false alarm is diagnosable; a false all-clear is not.

`STRIP` is exported and documented so an unexpected `updated` row can be traced to it.

### D3 — Liveness: environments and version lists are always live; snapshots cache forever

- `environments` and `versions` **fetch live on every invocation, never cached.** A publish repoints an
  environment, so a stale answer to "what's on Dev" is a wrong answer. They are single cheap list calls,
  and going live means neither command requires a prior `container pull`.
- **Version snapshots are immutable → cached forever.** No freshness check, no re-pull rule. This is the
  one place gallium's ">1h staleness" discipline correctly does not apply.
- **Any `@ref` auto-pulls its snapshot on first use.** Not just `diff` — every command. Erroring on
  `gallium list tags -c hl/checkout-cat@v42` while `diff --against 42` silently fetched would be an
  inconsistency the skill has to memorize. At most one fetch per version, ever.

### D4 — `diff` accepts a snapshot on either side

`diff`'s left side is whatever `-c` resolves to; its right side is whatever `--against` resolves to.
Both sides are entity sets compared by the same D2 hash, so version-vs-version and env-vs-env work with
no additional code.

```
gallium diff --against env:dev -c hl/checkout-cat      # workspace vs environment
gallium diff --against 42      -c hl/checkout-cat      # workspace vs version
gallium diff -c hl/checkout-cat@v41 --against 42       # version vs version
gallium diff -c hl/checkout-cat@live --against env:dev # env vs env
```

Without `--against`, behavior is byte-identical to today: the API-derived `changes` table, workspace vs
live. The one new error is a version-DB left side with no `--against` — a version has no pending-changes
list, and printing an empty table there would read as "no drift."

---

## Commands

| Command | Purpose |
|---|---|
| `gallium environments [-c <ref>] [--json]` | List environments and the version each points to |
| `gallium versions [-c <ref>] [--limit N] [--json]` | List version headers, newest first (default 20) |
| `gallium version <id> [-c <ref>] [--json]` | Prefetch a version snapshot; print its metadata |
| `gallium diff --against <target> [-c <ref>]` | Diff two entity sets instead of workspace-vs-live |

`--against` accepts `<versionId>`, `env:<name>`, `live`, or `latest`.

### `environments`

Two API calls: `environments.list` plus `version_headers.list`, so the output shows the *name* of the
version each environment points to rather than a bare id. That name is what makes the output readable.

Columns: `name`, `type`, `environment_id`, `version_id`, `version_name`.

Rows with `type == live` and `type == latest` are marked. An environment whose `containerVersionId` is
empty or `0` renders its version as `latest` — it auto-tracks the newest publish rather than pinning.

### `versions`

`version_headers.list`, paged via the existing `listAll`. The API's return order is not documented as
guaranteed, so gallium sorts explicitly by descending numeric `containerVersionId` before applying
`--limit` (default 20). Paging happens before truncation, so `--limit` bounds the output, not the fetch.

Columns: `version_id`, `name`, `deleted`, `num_tags`, `num_triggers`, `num_variables`.

**Correction to the original spec:** `ContainerVersionHeader` carries no timestamp, and `notes` exists
only on the full `ContainerVersion`. So this list can show neither date nor notes; notes surface via
`gallium version <id>`. This will be confirmed against the live API during implementation — if the
fields are genuinely absent, the columns are dropped rather than printed empty.

### `version <id>`

Given D3's auto-pull, this command is not required to make snapshots usable. It exists to prefetch
explicitly and to print the resolved version's metadata (id, name, notes, entity counts), which also
satisfies the preflight rule below.

### Naming note

`gallium version 42` sits next to `gallium --version`. The parser distinguishes them unambiguously
(`run()` matches `--version`/`-v` before command dispatch), but a reader may not. Kept as specified,
with help text disambiguating.

---

## Implementation

### `src/config/ref.ts` (new)

Parses a `-c` value into `{ alias, snapshot }`; rejects malformed `@` forms. Exposes `dbPathForRef()`.
`resolveAlias()` gains a sibling `resolveRef()` returning the config alias (for account/container ids)
alongside the DB path.

Config and admin commands — `container add | use | init | list | pull` — reject an `@ref` outright;
they operate on configured containers, not snapshots.

### `src/gtm/client.ts`

Four methods on the existing `getJson`/`listAll` primitives:

| Method | Path | Field |
|---|---|---|
| `listEnvironments(a, c)` | `accounts/{a}/containers/{c}/environments` | `environment` |
| `listVersionHeaders(a, c)` | `accounts/{a}/containers/{c}/version_headers` | `containerVersionHeader`, paged |
| `getVersion(a, c, id)` | `accounts/{a}/containers/{c}/versions/{id}` | — |
| `getLiveVersion(a, c)` | `accounts/{a}/containers/{c}/versions:live` | — |

`@latest` uses `version_headers:latest`. Using `versions:live` directly for `@live` is cleaner than
inferring it from the environment list.

Corresponding types in `src/gtm/types.ts`: `GtmEnvironment`, `GtmVersionHeader`, `GtmContainerVersion`.

### `src/pull/pull.ts` — ingest refactor

`pullContainer` currently interleaves fetching and ingesting. Split into:

- `ingestEntities(db, { tag, trigger, variable, builtInVariable, folder, customTemplate })` — pure
  ingest, no client dependency.
- `pullWorkspace(db, client, …)` — six list calls → `ingestEntities` → `getStatus()` changes → meta.
- `pullVersion(db, client, …)` — one `getVersion()` call → `ingestEntities` → meta.

Shape wrinkle: workspaces expose custom templates via `listTemplates`, versions inline them as
`customTemplate[]`. Normalized at the call site, not inside `ingestEntities`.

Version DBs set meta: `last_pulled_at`, `source=version`, `version_id`, `version_name`. Workspace DBs
set `source=workspace`. The `changes` table stays empty for version DBs.

### `src/pull/hash.ts` (new)

`STRIP`, `normalizeForHash(raw)`, `contentHash(raw)` per D2.

### Schema — `SCHEMA_VERSION` 1 → 2

Adds `entities.content_hash TEXT`, populated at ingest. `openDbAt` already drops every table on a
version mismatch, so existing caches self-invalidate.

**User-visible consequence:** the first command after upgrading reports "has never been pulled" and
requires one `gallium container pull`. This is the existing migration mechanism working as designed,
but it should be called out in the release notes.

### `src/commands/environments.ts`, `src/commands/versions.ts` (new)

`cmdEnvironments`, `cmdVersions`, `cmdVersion`.

### `src/commands/diff.ts`

`cmdDiff` gains `--against`. Resolution order: parse `--against` → resolve to a concrete version id
(via `environments.list` for `env:<name>`, `versions:live` for `live`, `version_headers:latest` for
`latest`) → ensure that snapshot is pulled → open both DBs → compare.

Comparison is a full outer join on `(kind, id)`:

| Condition | `change_status` |
|---|---|
| in both, hashes equal | omitted |
| in both, hashes differ | `updated` |
| left only | `added` |
| right only | `deleted` |

Output columns are unchanged from today's `diff` (`change_status`, `kind`, `name`, `id`) so the skill
parses one shape regardless of what was compared.

### `src/cli.ts`

`OPTIONS` gains `against` (string) and `limit` (string). `FLAT` gains `environments`, `versions`,
`version`.

### Skill — `src/skill/SKILL.md`, `src/skill/references/gtm-concepts.md`

- New **Versions & environments** section in the question→command table.
- Preflight parity: the existing rule requires stating which container is being analyzed. Extend it —
  for `environments`, `version`, and `diff --against`, also state the **resolved environment and version
  id**, so a wrong-target mismatch surfaces the same way a wrong-container mismatch does.
- A `gtm-concepts.md` section on the workspace / version / environment triangle: a workspace is mutable
  and per-user, a version is an immutable published snapshot, an environment is a named pointer at a
  version. Note that `@live` follows publishes while `@vN` is pinned.

---

## Error handling

| Situation | Behavior |
|---|---|
| `diff -c <alias>@v42` with no `--against` | Error: `diff` without `--against` compares a workspace against live; v42 is a version. |
| `--against env:<name>` names no existing environment | Error listing the available environment names. |
| `@ref` on a config/admin command (`container add`/`use`/`init`/`list`/`pull`) | Error: these commands take a container alias, not a snapshot ref. |
| Malformed ref (`alias@`, `alias@v`, `alias@nope`) | Error naming the valid forms: `@vN`, `@live`, `@latest`. |
| Version id does not exist | The API 404 surfaces through the existing `GTM GET … failed (404)` path. |
| Version snapshot not cached | Auto-pulled (D3); never an error. |

---

## Testing

**Unit**

- `hash.ts` — denylist stripping at top level and nested; key-order stability (same content, different
  key order → same hash); a change in an unmodeled field → different hash.
- `ref.ts` — all four ref forms, DB path derivation, malformed-`@` rejection, aliases containing `/`.
- `client.ts` — environments and version-header paging against a fake `fetch`, following the existing
  `client.test.ts` pattern.

**Integration**

- diff comparison over two in-memory DBs covering all four classifications (`updated`, `added`,
  `deleted`, omitted-when-equal).
- The identical-content case: same entities, different `path`/`fingerprint`/`workspaceId` → empty diff.
  This is the acceptance check and the one most likely to regress.
- `diff` with no `--against` against a version ref → error, not empty output.

**CLI**

- Routing and flag plumbing for `environments`, `versions`, `version`.
- `--against` and `--limit` parsing.

---

## Build order

1. `ref.ts` + schema bump + `hash.ts` + ingest refactor — the shared foundation, no new user-visible
   surface, all existing tests must still pass.
2. `gallium environments` — smallest command, answers the "what's on Dev" question on its own.
3. `gallium versions` + `gallium version <id>` — inspect a specific published snapshot.
4. `gallium diff --against` — the full comparison.
5. Skill updates.

---

## Acceptance check (the Honeylove case)

```
gallium environments -c honeylove/checkout-cat
gallium diff --against env:dev -c honeylove/checkout-cat
```

The first names the Dev environment's `containerVersionId`. The second must print an empty diff,
proving the Dev-deployed version matches the reviewed workspace — the assurance gallium cannot give
today.
