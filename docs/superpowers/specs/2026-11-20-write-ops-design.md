# Design: gallium workspace writes (no publish)

**Status:** approved by Charlie 2026-11-20. Supersedes `docs/write-ops-spec.md` (July draft); where they differ, this wins.

## Intent

Gallium can compute a GTM change exactly but cannot make it, so every change is retyped in the UI. Give it limited write access: it may edit a workspace, and it can never ship anything. Preview and publish stay a human action in the GTM UI, which keeps every gallium write discardable with its workspace.

First real use: one new trigger per container in a two-container setup, added as a blocking trigger to a few dozen existing tags (35 in one container, 11 in the other).

## Goals

- Create a workspace in a container.
- Create, update and delete tags, triggers, variables and folders in a named workspace, including Custom HTML and Custom JS.
- Read-only stays the default; write is an explicit opt-in at login.
- Bulk writes stay under the API quota and recover from quota errors.

## Non-goals

- Creating container versions, quick preview, publishing, and any environment write. Decided 2026-11-20: version creation is out.
- Templates, zones, clients, transformations, built-in variable enable/disable.
- Write access for the service-account path (stays read-only).
- Imperative per-entity verbs (`tags update --add-blocking …`). One surface, `apply`.

## Anti-goals

- A write landing in the Default Workspace, or in any workspace the user did not name on that command.
- A blind overwrite of someone else's concurrent edit.
- A silent partial apply.

## Constraints (verified against Google's docs 2026-11-20)

| fact | source |
|---|---|
| `workspaces.create`, entity create/update/delete, `workspaces.sync` require `tagmanager.edit.containers` | method reference pages |
| `versions.publish` requires `tagmanager.publish`; `create_version` and `quick_preview` require `tagmanager.edit.containerversions` | method reference pages |
| `environments.update` requires only `tagmanager.edit.containers` | method reference page |
| Quota: 25 requests per 100 s sliding window per project, 10,000 per day; exceeded returns `403` | limits-quotas page |
| Update is `PUT` with a `fingerprint` query parameter that "must match the fingerprint of the tag in storage" | `tags.update` page |

Two consequences:

- **The scope does not fully enforce "no publish".** `environments.update` is reachable under the write scope, and the docs do not say what it can change. Enforcement for environments is code-only: the client has no environment write method, and a test asserts it. The skill doc says so.
- **Quota figures conflict.** Charlie observed 30/min per user and a `429` on 2026-11-20. Pace to the stricter documented figure and retry on both statuses.

## Approaches considered

1. **Declarative `apply <file>`, dry-run by default (chosen).** The July draft already chose it; a file is reviewable before commit and re-runnable after a partial failure. Changed from the draft: entries may be patches, deletes are in, the workspace must be named, pacing and retry are added.
2. **Imperative verbs per entity.** Rejected: a second surface over the same engine, and 46 tag edits become 46 invocations with no single reviewable plan.
3. **Generate import JSON for the UI's Import Container.** Rejected: import merges by its own rules, cannot delete, and still leaves the hand step this exists to remove.

## Design

### Login and scope

- `gallium login` is unchanged: requests `tagmanager.readonly`.
- `gallium login --write` requests `tagmanager.readonly` and `tagmanager.edit.containers`. Nothing else, ever.
- Login records the granted scope (from the token response) beside the refresh token, and deletes the cached access token so the new grant takes effect at once. This also fixes today's bug where a re-login keeps using the old token for up to an hour.
- `apply --commit` refuses unless the recorded scope includes `edit.containers`, with a message naming `gallium login --write`. Service-account auth is always refused for writes.

### Command

```
gallium apply <spec.json> -c <alias> --workspace <name | new:Title> [--commit] [--json]
```

- `-c` is required; no fallback to the default container. `@` refs are rejected.
- `--workspace` is required. A name is matched exactly against the container's workspaces at run time; the alias's pinned `workspace_id` is ignored. "Default Workspace" is accepted only when typed. `new:Title` creates the workspace on `--commit`; if a workspace with that title already exists, it is reused (so a re-run converges).
- Without `--commit`: resolve, validate, print the plan (one line per entity, naming the fields that change; full request bodies with `--json`), exit 0, send no write. For `new:Title` not yet created, the plan is computed against the latest container version, which is what a new workspace is created from.
- With `--commit`: execute, then re-pull the target workspace and confirm every planned change is present. Print the workspace id, its GTM UI URL, and the summary.
- If the container's latest version is not the live version, warn: a new workspace will carry unpublished changes.

### Spec file

A JSON array of entries. `kind` is `tag | trigger | variable | folder`; `name` identifies the entity (case-insensitive; more than one match is an error).

| entry | meaning |
|---|---|
| name not in workspace, has `type` (folders need none) | create with the given fields |
| name in workspace | patch: each top-level field given replaces that field; everything else is kept from the stored JSON |
| `"delete": true` | delete; refused if anything outside the spec's own deletes still references it |

Helper fields, resolved from names to ids at apply time (a name may refer to an entity created in the same spec):

- `firingTriggers`, `blockingTriggers`: set the whole list by trigger name.
- `addFiringTriggers`, `removeFiringTriggers`, `addBlockingTriggers`, `removeBlockingTriggers`: edit the list; adding one already present is a no-op.
- `folder`: folder name, resolved to `parentFolderId`.
- `rename`: new name for an existing entity.
- On any parameter, `valueFile` instead of `value`: path relative to the spec file, read as the value. This is how Custom HTML and Custom JS are authored without escaping code into JSON. *(builder's call, mine)*

Validation, all before the first write: every trigger, folder and `{{variable}}` reference resolves (in the workspace, the spec, or the enabled built-ins); no ambiguous name; no entry both patches and deletes; delete reference check. A patch that changes nothing is reported as unchanged and sends no request.

Order: folders, variables, triggers, tags for create/update; then deletes in the reverse order.

### Client

- One private `request(method, path, {query, body})` under the existing readers; `getJson` goes through it.
- New methods only: `createWorkspace`, and `create/update/delete` for tag, trigger, variable, folder. Updates send the stored `fingerprint`. **No method for versions, publish, quick preview or environments beyond the existing reads**, and a test fails if one appears.
- **Pacing, all requests including reads:** at most 20 requests in any 100 s window, tracked in a small file in the cache dir so consecutive invocations share the window. *(my call: the 2026-11-20 quota hit was reads across invocations, which an in-process limiter would not have prevented)*
- **Retry:** on `429`, or `403` whose error reason is a rate or quota reason, wait (honouring `Retry-After`, else exponential backoff with jitter) and retry up to 5 times. Any other `403` fails immediately.
- A fingerprint mismatch stops the apply and says to re-run (the next run re-pulls).

### Failure

GTM has no multi-entity transaction. On the first failed write, stop, and print what was applied and what was not. Re-running the same spec converges.

### Docs

- `src/skill/SKILL.md`: frontmatter description, opening line, a Writes section (login `--write`, `apply`, dry-run first, named workspace, never publishes, the environment caveat), and the pacing note. `README.md` and the tap formula `desc` lose "read-only". `docs/write-ops-spec.md` is marked superseded.

## Testing

- Unit, colocated `*.test.ts` with injected `fetchFn`: plan building (create, patch, helper lists, rename, delete, no-op), reference resolution and ordering, validation failures, dry-run sends no non-GET request, workspace resolution (named, `new:`, Default refused unless named), scope gate, pacing window, retry on `429` and quota `403`, no retry on permission `403`, fingerprint sent on PUT, absence of publish/version/environment write methods.
- Acceptance (Charlie runs the commit): the first-use change, dry-run then `--commit` into a new workspace per container; `gallium diff` against the live version of each shows one new trigger and the listed tags changed in `blockingTriggerId` only. The spec files live outside this repo.

## Left to the builder

Module layout (a pure planner separate from the command), exact plan output format, limiter file format, how the target workspace is pulled for planning (a cache keyed by workspace id, or in memory).
