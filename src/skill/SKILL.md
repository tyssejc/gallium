---
name: gallium
description: Use when answering read-only questions about a Google Tag Manager container — which tags fire on a trigger, what references a variable, what custom code touches a string, what's changed in the workspace vs. the live version, what version is published to an environment, what changed between two publishes, listing/auditing tags, triggers, and variables, or discovering accounts/containers/workspaces. Drives the `gallium` CLI.
---

# GTM container analysis

Use the `gallium` CLI to answer read-only questions about a Google Tag Manager container workspace. Users refer to a container by alias (e.g. `acme/web`) **or** by its real name — a domain (`www.example.com`), a public ID (`GTM-XXXXXX`), or an account/brand ("the Pitman Training container").

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

## Interpreting results

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
