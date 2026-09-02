# GTM concepts (for gallium)

## Workspaces, versions, environments

- A **container** holds tags, triggers, variables, folders, built-in variables, and custom templates.
- A **workspace** is the mutable, per-user editing area. Changes live here until published. `gallium` pulls
  the configured workspace, and `gallium diff` with no arguments shows what it has that live doesn't.
- A **version** is an immutable numbered snapshot created by publishing. It never changes once created,
  which is why gallium caches version snapshots forever with no freshness check.
- An **environment** is a *named pointer* at a version, with its own snippet/auth code. `Live` points at the
  published production version; `Latest` auto-tracks the newest version; user-defined ones (Dev, Staging)
  point wherever they were last published to.
- `diff`/`dirty` with no `--against` reflect the workspace's pending changes vs. its base version, via the
  API's own workspace status.

The consequence that matters: **"published" is ambiguous.** Work can be published to a Dev environment
without being live in production. A workspace can therefore show changes as pending relative to *live*
while being byte-identical to what's deployed on *Dev*. `gallium diff --against env:dev` is what settles
it; `gallium diff` alone cannot.

Pinning: `@v42` is fixed forever. `@live` and `@latest` re-resolve on every invocation and will follow a
new publish.

## Web vs. server containers
- gallium v1 targets **web** containers (tags/triggers/variables).
- **Server-side** containers use **Clients** (the analogue of tags/triggers) and a different model — deferred to a later phase.

## Zones
- **Zones** are a **web-container feature available only with GTM 360**. They let one container delegate to others. Out of v1 scope; not server-side.

## dataLayer / gtag.js footguns (bake into any generated code)
- Pushes to `window.dataLayer` for gtag.js MUST use a traditional function so the **Arguments object** is captured:
  `function gtag(){ dataLayer.push(arguments); }`
  Arrow functions / rest params are **silently ignored** — zero network requests, no error. Extremely hard to diagnose.
- Biome's `useArrowFunction` rule rewrites `function(){…}` to `() => …`, reintroducing the bug. Suppress with `biome-ignore lint/complexity/useArrowFunction`, or use a named function declaration (which Biome leaves alone).

## Import-JSON gotchas (groundwork for v2 authoring)
- Parameter shape: nested rows are `LIST` of `MAP`, not `PARAM_TABLE`.
- Trigger references inside a tag must be self-contained in the import.
- `parentFolderId` references must resolve to a folder present in the import.
- Custom HTML/templates may require explicit logging permission to be valid.
