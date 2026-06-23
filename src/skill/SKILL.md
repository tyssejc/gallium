---
name: gallium
description: Use when answering read-only questions about a Google Tag Manager container — which tags fire on a trigger, what references a variable, what custom code touches a string, what's changed in the workspace vs. the live version, listing/auditing tags, triggers, and variables, or discovering accounts/containers/workspaces. Drives the `gallium` CLI.
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

### Step 2 — Make sure that container is pulled and fresh (use `-c <alias>` for the target).

- `gallium container status -c <alias> --json` → if `last_pulled_at` is null, run `gallium container pull <alias>` first.
  - For OAuth, the user must run `gallium login` once (top-level, not per-container) before the first pull. One login authorizes all containers.
- If `last_pulled_at` is stale (>~1h) or the question implies recent edits ("did someone just change…") → pull again before answering.

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
