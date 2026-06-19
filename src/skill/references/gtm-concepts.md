# GTM concepts (for gallium)

## Workspaces, versions, environments
- A **container** holds tags, triggers, variables, folders, built-in variables, and custom templates.
- A **workspace** is the editable working copy. `gallium` pulls the configured workspace.
- A **version** is an immutable snapshot created on publish. The **live** version is what's serving.
- `diff`/`dirty` reflect the workspace's pending changes vs. its base version, via the API's workspace status.
- **Environments** (e.g. Live, Latest, custom) point at versions; not modeled in gallium v1.

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
