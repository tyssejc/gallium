# Gallium — GTM Skill Design

**Date:** 2026-06-19
**Status:** Approved design, pre-implementation
**Codename:** `gallium` (binary `gallium`; symbol Ga — a nod to Google Analytics, continuing the element-codename theme started by `cadmium` for Adobe Tags)

## Problem & motivation

Working with Google Tag Manager from an agent harness has two recurring friction points:

1. **Answering questions about a container is tedious.** "What fires this trigger?", "what reads `{{Variable Z}}`?", "what changed since the last publish?", "is there a Custom HTML tag touching `dataLayer.foo`?" — all require clicking through the GTM UI or hand-rolling API calls.
2. **Hand-building container import JSON is error-prone.** Surfaced during the Rokt → mParticle migration (honeylove, May 2026): a repeated `edit → jq/python build → import → fix-validation-error` loop, with recurring gotchas (`PARAM_TABLE`→`LIST` shape, self-contained trigger refs, `parentFolderId` integrity, logging permission).

This project builds a CLI + skill that nails (1) first (read-only analysis), then layers (2) on as a fast follow (authoring/validation).

## Precedent

This deliberately clones the proven shape of the existing **`adobe-tags` skill** and its **`cadmium`** CLI:

- bun/TypeScript CLI, distributed via Homebrew.
- A thin `SKILL.md` that maps natural-language questions → CLI commands, with a "preflight sync" discipline.
- Per-property local SQLite snapshot (`~/.cache/`), TOML config with aliases (`~/.config/`), cached auth tokens.
- "Head vs. published" snapshot model that enables diffing.

Where `cadmium` syncs a Reactor *property* and answers Adobe Analytics questions, `gallium` syncs a GTM *container workspace* and answers GTM questions.

## Delivery shape

**CLI + thin skill.** A standalone `gallium` binary plus a `SKILL.md`. Works in any harness with a shell; the skill file is plain markdown. (Decision: not MCP for v1 — a CLI is the most portable across harnesses; an optional MCP wrapper that shells out to the CLI remains possible later.)

## Architecture

```
src/
  auth/        OAuth user flow (default) + service-account key (opt-in)
  gtm/         Tag Manager API v2 client
  pull/        Pull container workspace + latest version → SQLite snapshot (v2 adds push/)
  cache/       SQLite read/query layer (bun:sqlite)
  commands/    One module per command group (refs, tag, trigger, code, diff, list, container)
  config/      ~/.config/gallium/config.toml — container aliases
  paths.ts     XDG-aware paths
  skill/       SKILL.md + references/gtm-concepts.md
bin/gallium.ts
Formula/       Homebrew formula
```

Each module has one clear job and a defined interface: `gtm/` knows the API and nothing about SQLite; `cache/` knows SQLite and nothing about the API; `pull/` wires them; `commands/` only read from `cache/`.

**Command naming:** the v1 read transfer is `pull` (not `sync`) — `sync` implies bidirectionality, but v1 is strictly read-only. The complementary `push` (write back) arrives with the v2 authoring layer. (Follow-up, out of scope here: rename `cadmium`'s `sync` → `pull` for the same reason, to keep the two tools symmetric.)

## Auth model

**Support both**, OAuth as the default path:

- **OAuth user flow (default):** interactive browser consent, refresh token cached locally under `~/.cache/gallium/.tokens/`. Acts as the user; sees every container they can. Best DX for solo client work across many containers. Matches the `cadmium` precedent.
- **Service account (opt-in via config):** JSON key file; the SA email must be granted access per GTM account. For CI/headless/shared use. No browser.

## Data model & pull

`gallium pull <alias>` pulls **two snapshots** per alias into SQLite:

1. The **working workspace** (the live editable copy) — the default source for most queries.
2. The **latest published version** — used as the baseline for `diff`.

Entities synced (web container, v1): **tags, triggers, variables, built-in variables, folders, custom templates**, plus version/environment metadata.

**Explicitly deferred from v1** (future phases, in rough priority order):
- **Server-side containers** — Clients are the server-side analogue of tags/triggers; the server data model differs enough to warrant its own phase. The user has confirmed this is wanted eventually.
- **Zones** — a *web*-container feature gated to **GTM 360** (not a server-side feature). Out of v1 scope; revisit alongside enterprise needs.

## Preflight discipline (baked into SKILL.md)

Like `adobe-tags`, every question begins with a freshness check:

1. `gallium container status --json` — check `last_pulled_at`.
2. If null → `gallium pull` first.
3. If stale (~>1h) or the question implies recent edits → suggest a pull.
4. If no container is selected → ask which alias, or suggest `gallium container use <alias>` to set a default.

## v1 command set (read-only core)

All four prioritized capabilities — reference/dependency graph, custom code search, workspace diff/dirty, inventory + unused.

| User asks | Command |
|---|---|
| What references `{{Variable Z}}`? Who reads/writes it? | `gallium refs 'Variable Z' --json` |
| What triggers does tag Y fire on? | `gallium tag 'Y' --json` |
| What tags fire on trigger T? | `gallium trigger 'T' --refs --json` |
| Grep custom code (Custom HTML tags, Custom JS variables, template code) | `gallium code search '<pattern>' --json` |
| What changed vs. the live published version? | `gallium diff --json` |
| What's edited-but-unpublished / paused / orphaned? | `gallium dirty --json` |
| List tags/triggers/variables/folders, filtered | `gallium list tags [--type html] [--folder X] [--paused] --json` |
| Variables/triggers referenced nowhere | `gallium list variables --unused --json` |

Conventions (from `cadmium`): every command accepts `--json` and is parsed by the agent; answers lead with the conclusion, not the raw list.

## v2 authoring layer (fast follow — not v1)

Generate + validate GTM container **import JSON**, directly attacking the Rokt-migration pain — surfaced via a `gallium push` command (the write-back complement to `pull`). The recurring gotchas become **named validators**:

- `PARAM_TABLE` → `LIST` parameter shape
- self-contained trigger references
- `parentFolderId` referential integrity
- logging-permission presence

**First v2 decision (flagged, not resolved now):** whether authoring emits import-JSON for the GTM UI's *Import Container* (merge mode) or writes directly into a workspace via the API. Different schemas, different blast radius. To be brainstormed when v2 starts.

## Reference knowledge baked into the skill

`references/gtm-concepts.md` captures what an agent reliably gets wrong (the user will review this file specifically):

- **gtag.js Arguments-object footgun:** pushes to `window.dataLayer` for gtag.js MUST use `function(){ dataLayer.push(arguments) }` — arrow functions / rest params are silently ignored (zero requests, no error). Biome's `useArrowFunction` rule reintroduces the bug; suppress it or use a named function declaration.
- **Workspace / version / environment relationships:** how the editable workspace, published versions, and environments relate (the basis for `diff` and `dirty`).
- **Web vs. server containers; Zones:** Zones are a *web*-container feature available only with **GTM 360**; server-side containers use **Clients** as the analogue of tags/triggers. Both are out of v1 scope.
- **Import-JSON gotchas:** the `PARAM_TABLE`/`LIST`, trigger-ref, `parentFolderId`, and logging-permission issues above (groundwork for v2).

## Distribution & testing

- **Distribution:** Homebrew formula + bun, like `cadmium`.
- **Testing:** `bun test` covering the API client (recorded fixtures), the reference-graph builder, the `diff` logic, and `paths`/config resolution.

## Out of scope

- The SHA-256 GTM Community Template Gallery variable (a separate project noted in the same backlog, not part of this skill).
- MCP server (possible later as a thin wrapper over the CLI).
- Server-side containers and Zones (future phases, per above).
