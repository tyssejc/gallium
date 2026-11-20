---
name: gallium
description: Use when answering questions about a Google Tag Manager container — which tags fire on a trigger, what references a variable, what custom code touches a string, what's changed in the workspace vs. the live version, what version is published to an environment, what changed between two publishes, listing/auditing tags, triggers, and variables, or discovering accounts/containers/workspaces — or when creating or editing tags, triggers, variables and folders in a named workspace (never publishing). Drives the `gallium` CLI.
---

# GTM container analysis

Use the `gallium` CLI to answer questions about a Google Tag Manager container workspace. It reads by default; it writes only through `gallium apply` (see Writes). Users refer to a container by alias (e.g. `acme/web`) **or** by its real name — a domain (`www.example.com`), a public ID (`GTM-XXXXXX`), or an account/brand ("the Pitman Training container").

## Preflight (always)

### Step 1 — Identify the target container. Never assume the active default is what the user means.

- Map the user's words to a container. First check configured aliases: `gallium container list --json`.
  - **Matches a configured alias** → use it explicitly with `-c <alias>` on every command for this question. Do not rely on whichever default happens to be set.
  - **Not configured yet** → discover it: `gallium accounts --json` (find the account by name) → `gallium containers <accountId> --json` (match the container by `name` or `public_id`) → `gallium workspaces <accountId> <containerId> --json` (usually "Default Workspace") → register it: `gallium container add <alias> <accountId> <containerId> <workspaceId>`.
  - **Question names no container** → fall back to the default (`gallium container status --json` shows it). If there's no default either, ask which one.
- When you've picked a container, **state which one you're analyzing (alias + real name)** before answering, so a wrong-container mismatch surfaces immediately. Beware similarly-named containers (e.g. `www.example.com` vs `www.example.com OLD`, or per-country variants) — match the exact name/public ID.
- When a question concerns a **version or environment** rather than the workspace, also state the
  **environment name and the version id it resolved to** before answering (`gallium environments list --json`
  shows both). A wrong-target mismatch — reading Dev when the user meant Live — must surface the same way a
  wrong-container mismatch does.

### Step 2 — Make sure that container is pulled and fresh (use `-c <alias>` for the target).

- `gallium container status -c <alias> --json` → if `last_pulled_at` is null, run `gallium container pull <alias>` first.
  - For OAuth, the user must run `gallium login` once (top-level, not per-container) before the first pull. One login authorizes all containers.
- If `last_pulled_at` is stale (>~1h) or the question implies recent edits ("did someone just change…") → pull again before answering.
- Version snapshots (`-c <alias>@v42`, `@live`, `@latest`) are **immutable and cached forever** — the
  staleness rule above does not apply to them, and they are fetched automatically on first use. Only the
  *workspace* needs a freshness check.

## Question → command

### Discovery

| User asks | Command |
|---|---|
| What GTM accounts can I see? | `gallium accounts --json` |
| What containers do I have access to? | `gallium containers --json` |
| Containers for a specific account | `gallium containers <accountId> --json` |
| What workspaces exist in a container? | `gallium workspaces <accountId> <containerId> --json` |
| Save a container alias from discovered IDs | `gallium container add <alias> <accountId> <containerId> <workspaceId>` |

### Analysis

| User asks | Command |
|---|---|
| What references `{{Variable Z}}`? | `gallium variables refs 'Variable Z' --json` |
| What triggers does tag Y fire on? | `gallium tags triggers 'Y' --json` |
| What tags fire on trigger T? | `gallium triggers tags 'T' --json` |
| Full config of tag X (params, mappings) | `gallium tags get 'X' --json` |
| Full config of a trigger / variable / folder | `gallium triggers get 'X'`, `gallium variables get 'X'`, `gallium folders get 'X'` |
| Find custom code touching `dataLayer.foo` | `gallium code search 'dataLayer.foo' --json` |
| What changed vs. the live version? | `gallium diff --json` |
| Anything edited-but-unpublished / paused? | `gallium dirty --json` |
| List tags / triggers / variables / folders | `gallium tags list [--type html] [--folder ID] [--paused] --json` |
| Variables referenced nowhere | `gallium variables list --unused --json` |

Every entity noun takes the same shape: `gallium <tags|triggers|variables|folders> <list|get> [name]`, plus a
relation verb where one exists (`tags triggers`, `triggers tags`, `variables refs`). The noun carries the
kind, so `gallium tags get 'X'` is never ambiguous even when a tag and a variable share a name.

### Versions & environments

| User asks | Command |
|---|---|
| What version is published to Dev / Live? | `gallium environments list --json` |
| What versions exist? | `gallium versions list [--limit N] --json` |
| When was each version created? | `gallium versions list --dates --json` |
| Details of version N (name, description, date, counts) | `gallium versions get N --json` |
| Does my workspace match what's on Dev? | `gallium diff --against env:dev --json` |
| What changed between two publishes? | `gallium diff -c <alias>@v41 --against 42 --json` |
| Inspect the config of a published version | any analysis command with `-c <alias>@v42` |

Any container ref accepts an `@` suffix naming an immutable snapshot: `@v42`, `@live` (newest published),
`@latest` (newest version, published or not). So `gallium tags list -c acme/web@live --json` lists the tags
as actually published, and `gallium tags get 'My Tag' -c acme/web@v42` shows that tag's config in version 42.
`--against` additionally accepts `env:<name>`.

## Writes

Follow these in order.

1. **Gallium cannot publish, create versions or preview.** It only edits a workspace. The user previews and publishes in the GTM UI. Never tell the user a change is live.
2. **Writing needs a one-time `gallium login --write`, which the user runs themselves** (it opens a browser). A plain `gallium login` is read-only and `apply --commit` refuses with it. Service-account auth can never write. Do not run the login for them.
3. **Always dry-run first and show the user the plan before `--commit`.** `gallium apply <spec.json> -c <alias> --workspace <name|new:Title>` sends nothing and prints one line per entity (`CREATE`, `UPDATE` with the fields that change, `DELETE`, `UNCHANGED`). Its first line is `Target: <alias> — workspace "<name>" (<id>)`, or `(will be created)` for a `new:` workspace; read that line back to the user, with the plan, before `--commit`. Add `--json` for the full request bodies (`container` and `workspace` name the target there). Only after the user approves the plan, run the same command with `--commit`.
4. **`--workspace` is mandatory, and so is `-c <alias>`** (no default container, no `@` refs). Use `new:<Title>` to put a change set in its own workspace: it is created on `--commit`, and an existing workspace with that exact title is reused, so a re-run converges. A plain name must match an existing workspace exactly. The alias's pinned workspace is ignored. Never use "Default Workspace" unless the user said to.
5. **The spec is a JSON array of entries.** Each has `kind` (`tag`, `trigger`, `variable` or `folder`) and `name`.

   | Entry | Meaning |
   |---|---|
   | name not in the workspace, with `type` (folders need none) | create with the given fields |
   | name already in the workspace | patch: each top-level field you give replaces that field; everything else is kept |
   | `"delete": true` (nothing else in the entry) | delete |

   Any other field is a GTM API field, passed through as written. Helper fields are resolved from names to ids when the plan is built, and a name may refer to an entity created in the same spec:

   - `firingTriggers`, `blockingTriggers` (tags only): set the whole list, by trigger name.
   - `addFiringTriggers`, `removeFiringTriggers`, `addBlockingTriggers`, `removeBlockingTriggers` (tags only): edit the list. Adding one that is already there is a no-op.
   - The built-in triggers `All Pages`, `Initialization - All Pages` and `Consent Initialization - All Pages` can be referenced by name in any of the trigger-list fields above, though they cannot be created, renamed or deleted.
   - `folder`: a folder name, resolved to `parentFolderId`.
   - `rename`: the new name of an existing entity.
   - `valueFile` in place of `value` on any parameter: a path relative to the spec file, whose contents become the value. Use it for Custom HTML and Custom JS so code is not escaped into JSON.

   Worked example: a custom-event blocking trigger, added as a blocking trigger to two existing tags.

   ```json
   [
     {
       "kind": "trigger",
       "name": "Block - GPC Enabled",
       "type": "customEvent",
       "customEventFilter": [
         { "type": "matchRegex", "parameter": [
           { "type": "template", "key": "arg0", "value": "{{_event}}" },
           { "type": "template", "key": "arg1", "value": ".*" }
         ] }
       ],
       "filter": [
         { "type": "equals", "parameter": [
           { "type": "template", "key": "arg0", "value": "{{JS - GPC Enabled}}" },
           { "type": "template", "key": "arg1", "value": "true" }
         ] }
       ]
     },
     { "kind": "tag", "name": "GA4 - Purchase", "addBlockingTriggers": ["Block - GPC Enabled"] },
     { "kind": "tag", "name": "Ads - Remarketing", "addBlockingTriggers": ["Block - GPC Enabled"] }
   ]
   ```

   Custom HTML tag whose code lives in a file next to the spec (`banner.html`):

   ```json
   {
     "kind": "tag", "name": "HTML - Consent Banner", "type": "html",
     "parameter": [
       { "type": "template", "key": "html", "valueFile": "banner.html" },
       { "type": "boolean", "key": "supportDocumentWrite", "value": "false" }
     ],
     "firingTriggers": ["All Pages"]
   }
   ```

   Rules the planner enforces. Any violation fails the whole dry-run with every problem listed, before anything is written:

   - Every trigger, folder and `{{variable}}` reference must resolve, in the workspace, in the spec, or among the enabled built-in variables. A name matching more than one entity is an error.
   - Entity names match case-insensitively, but `{{variable}}` references are case-sensitive and must use the variable's exact name.
   - Renaming a variable or tag is refused while anything still references the old name (GTM does not rewrite references). Update the referrers first, in a separate apply.
   - A name that the same spec deletes cannot be reused in that spec. Delete first, then create in a second apply.
   - Deleting is refused while anything outside the spec's own deletes still references the target.
   - A patch that changes nothing is reported `UNCHANGED` and sends no request.
   - Order of writes: folders, variables, triggers, tags; then deletes in the reverse order.
   - Removing a trigger (`removeFiringTriggers`, `removeBlockingTriggers`) that matches nothing is an error, unless the same spec deletes a trigger of that name.
   - GTM has no transaction. On the first failed write gallium stops and prints what was applied (`FAILED`, then `NOT APPLIED` for the rest). Fix the cause and re-run the same spec; it converges. If it reports the entity changed since it was read, just re-run.
6. **A commit is slow: allow for it.** Pacing makes a commit of N entities take roughly N × 5 seconds plus setup, so run `apply --commit` with a 10-minute command timeout. Each write prints its line to stderr as it lands, and a long pacing pause prints `gallium: pacing — waiting <N>s …`; stdout carries only the final report. If the command is interrupted, re-run the same command: it converges and reports what is already applied as `UNCHANGED`.
7. **After a commit, give the user the workspace URL** gallium prints, and verify with `gallium diff`. `diff` reads the alias's pinned workspace, which is usually not the one you wrote to, so register the written workspace under a new alias first (the workspace id is in the URL and the `APPLIED` line): `gallium container add <alias>-<title> <accountId> <containerId> <workspaceId>`, then `gallium container pull <alias>-<title>` and `gallium diff -c <alias>-<title> --json`. Report the result and tell the user the change is not published. Gallium also re-reads the workspace itself after a commit: `NOT VERIFIED` lines mean a planned change is missing, and `VERIFY FAILED` means the re-read errored. Treat either as a failed apply and say so.
8. Caveat: `The write scope also covers the environments API. Gallium has no command for it; do not call it by other means.`

## Interpreting results

- Every request gallium makes is paced to 20 per 100 s, shared across invocations. A long pause is pacing, not a hang (gallium prints a `pacing — waiting` line on stderr when it happens); do not kill it or retry. For `apply --commit` see Writes, item 6. Quota errors are retried automatically.
- Always pass `--json` and parse it. Lead the answer with the conclusion, not the raw list.
- `variables refs` returns every entity (tag/trigger/variable) whose parameters or code contain the `{{name}}` token.
- `tags triggers` / `triggers tags` resolve the firing/blocking relationship in both directions.
- The pre-v0.3.0 spellings (`list <kind>`, `tag`, `trigger`, `refs`, `show`) still work but print a
  deprecation warning to stderr. Use the noun-group form above; if you see that warning in output, the
  installed skill is stale and should be refreshed with `gallium skill install`.
- `diff`/`dirty` come from the GTM API's own workspace status — they show entities added/updated/deleted in the working workspace relative to the live container version.
- `diff --against` is computed **locally** by comparing entity content, not by the GTM API. An empty result
  is a positive assurance that the two sides match. It ignores storage bookkeeping (`fingerprint`, `path`,
  workspace/version ids) and treats everything else as content — so an unexpected `updated` row with no
  visible difference means a field gallium doesn't model changed; use `gallium show` on both sides to see it.
- An environment whose `version_id` reads `latest` is not pinned — it auto-tracks the newest publish.
- A version's `description` is the publisher's own note about *why* the version exists — quote it before
  inferring intent from the diff. It is available from `versions get`, never from `versions list`, because
  the API's header resource omits it.
- `created_at` is derived from the version's `fingerprint`, which GTM recomputes on every write to that
  version. It dates creation or last modification, **not** publication — an old version renamed last week
  will read as last week. To find what is actually deployed somewhere, use `gallium environments list`.
  `versions list --dates` costs one full version fetch per row, so pass `--limit`.
- See `references/gtm-concepts.md` for workspace/version/environment relationships, web vs. server containers, Zones (GTM 360), and dataLayer/gtag.js footguns.
