# Spec: gallium write operations

**Status:** superseded 2026-11-20 by `docs/superpowers/specs/2026-11-20-write-ops-design.md`. Kept for the reasoning; do not build from it.
**Author context:** grows out of the AOLCC `form_start` build, where the entire GTM change (1 variable, 1 trigger, 2 tags) was authored by hand in the UI from a spec gallium had already computed. Gallium can *see* the container perfectly; it just can't *act* on it. This closes that gap — carefully.

## Design tenets

1. **Read stays the default posture.** Writes are opt-in, explicit, and loud. Nothing about adding writes should make a `gallium refs` feel risky.
2. **Never publish.** Gallium may create/update entities **in a workspace only**. Creating container versions and publishing stay a human action in the GTM UI. This is the single most important safety boundary — it means every gallium write is reversible by discarding the workspace.
3. **Dry-run by default.** A write command with no explicit commit flag prints the exact API payload(s) it *would* send and exits 0 without touching the API.
4. **No default container for writes.** Reads fall back to the default container; writes require an explicit `-c <alias>` so you can never mutate "whichever container happened to be selected."
5. **Declarative + idempotent.** You describe the desired entity; gallium creates it or updates the existing one matched by name. Re-running converges rather than duplicating.

## Prerequisite: OAuth scope

Current scope (`src/auth/oauth.ts`):

```
https://www.googleapis.com/auth/tagmanager.readonly
```

Writes need the container-edit scope (workspace entity CRUD, **not** publish):

```
https://www.googleapis.com/auth/tagmanager.edit.containers
```

- Add it alongside readonly; request both. `gallium login` re-consent required once.
- **Explicitly do NOT** request `tagmanager.publish` or `edit.containerversions` — publishing is out of scope by design (tenet 2).
- Service-account path (`serviceAccount.ts`) already passes an arbitrary scope string; the SA principal needs the **Editor** container role.

## Command surface

Two entry points, sharing one engine:

```bash
# Declarative: apply one or more entity specs from a file
gallium apply <spec.json> -c <alias> [--commit] [--workspace <id|name|new:Title>]

# Convenience: create/update a single entity inline (thin wrapper over apply)
gallium create variable "DLV - lead_type" --type v --json-params '{...}' -c <alias> [--commit]
```

- **Default = dry-run.** Prints a per-entity plan: `CREATE variable "DLV - lead_type"` / `UPDATE tag "GA4 Event | Generate Lead" (adds eventSettingsTable[+1])`, plus the raw JSON body. `--commit` performs it.
- After a commit, gallium **auto-pulls** the workspace so the local cache reflects reality, then prints `gallium show`-style confirmation for each written entity.

### Spec file format

A list of desired entities. Cross-references use `{{Name}}` and are resolved to IDs at apply time (create order is topologically sorted: variables → triggers → tags).

```json
[
  { "kind": "variable", "name": "DLV - lead_type", "type": "v",
    "parameter": [
      { "type": "integer",  "key": "dataLayerVersion", "value": "2" },
      { "type": "template", "key": "name",             "value": "lead_type" }
    ] },
  { "kind": "trigger", "name": "Event - form_start", "type": "customEvent",
    "customEventFilter": [ { "type": "equals", "parameter": [
      { "type": "template", "key": "arg0", "value": "{{_event}}" },
      { "type": "template", "key": "arg1", "value": "form_start" } ] } ] },
  { "kind": "tag", "name": "GA4 Event | Form Start", "type": "gaawe",
    "firingTriggerRef": [ "Event - form_start" ],
    "parameter": [ /* eventSettingsTable with {{DLV - lead_type}} etc. */ ] }
]
```

- `firingTriggerRef` (names) is resolved to `firingTriggerId` (ids). Variable `{{...}}` references are validated to exist (or be in the same spec) before any write.
- **Pre-flight validation**, all before the first write: every referenced variable/trigger resolves; no name collision that would ambiguously match >1 existing entity; types are known GTM type strings.

## GTM API mapping

Workspace-scoped REST (v2), base `accounts/{a}/containers/{c}/workspaces/{w}`:

| Op | Method + path |
|---|---|
| Create variable | `POST .../variables` |
| Update variable | `PUT .../variables/{id}` (send full entity + `fingerprint`) |
| Create trigger | `POST .../triggers` |
| Create tag | `POST .../tags` |
| Update tag | `PUT .../tags/{id}` |

- **Optimistic concurrency:** updates must send the `fingerprint` from the last pull; a stale fingerprint 409s → gallium tells the user to `pull` and retry. (Never blind-overwrite.)
- The mutation layer lives in `src/gtm/client.ts` alongside the existing readers; commands compose it exactly like the read commands compose the cache repo.

## First real target — the `form_start` build

The spec ships with `examples/aolcc-form-start.json` = the four entities from `aolcc/2026-07-03_form-start-gtm-build.md` (DLV - lead_type, Event - form_start trigger, GA4 Event | Form Start tag, plus the Generate Lead `lead_type` param update). Running it end-to-end (dry-run → review → `--commit` into a scratch workspace → human review in UI → human publish) is the acceptance test for the feature.

## Verification / testing strategy

- **Unit:** spec → API payload transformation (pure function, mock client). Ref resolution, topological ordering, dry-run vs commit branching, fingerprint pass-through. Mirrors the existing `*.test.ts` pattern with an injected fake GTM client.
- **Manual acceptance:** the form_start example against a real scratch workspace, confirming `gallium show` post-write matches intent and the UI diff is exactly the four entities.

## Open design questions

### ⭐ Workspace identity should not be baked into config (from Charlie)

Today `[containers."alias"]` pins `workspace_id`. **Workspaces are short-lived** — they're created and merged/discarded constantly, so a pinned id goes stale fast (we hit exactly this: `aolcc/media` pinned ws 58, but live was 63, so pulls silently returned empty). For writes this is worse than annoying — it's a correctness hazard (mutate the wrong/dead workspace).

Options to explore (not decided):
- **Resolve by policy, not id.** Config stores account+container + a *workspace policy*: `"default"` (the "Default Workspace" by name), `"latest"`, or an explicit id. Resolve at runtime.
- **`--workspace <id|name|new:Title>` per write**, defaulting to the resolved default workspace; `new:Title` **creates a fresh workspace** for the change set (matches GTM best practice of one workspace per unit of work) and targets it.
- **Short-TTL workspace cache** with a staleness warning when the pinned id no longer exists (surface "workspace 58 not found — did it get merged?" instead of an empty pull).
- Decouple: `gallium pull` warns on stale/missing workspace; write commands refuse a stale workspace outright.

Leaning: account+container in config, workspace resolved per-invocation (default-by-name, override with `--workspace`, `new:` to create). Revisit when building.

### Others
- Delete support? Probably not in v1 — deletes are the least reversible workspace op. Defer.
- Folder placement on create (parentFolderId) — nice-to-have; the form_start tag should land in the same folder as Generate Lead (id 118).
- Batch/transaction semantics: GTM has no multi-entity transaction. On a mid-apply failure, gallium should stop and report what was already created (the workspace is discardable, so partial state is safe but must be reported clearly).
