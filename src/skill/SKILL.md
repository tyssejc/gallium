---
name: gallium
description: Use when answering read-only questions about a Google Tag Manager container — which tags fire on a trigger, what references a variable, what custom code touches a string, what's changed in the workspace vs. the live version, or listing/auditing tags, triggers, and variables. Drives the `gallium` CLI.
---

# GTM container analysis

Use the `gallium` CLI to answer read-only questions about a Google Tag Manager container workspace. Users refer to containers by alias (e.g. `acme/web`).

## Preflight (always)

1. Run `gallium container status --json` (add `-c <alias>` if it isn't the default).
2. If `last_pulled_at` is null → run `gallium container pull <alias>` first.
   - For OAuth accounts, the user must run `gallium container login <alias>` once before the first pull to store the refresh token.
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
