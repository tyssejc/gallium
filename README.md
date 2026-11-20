# gallium

Google Tag Manager container analysis CLI. Answers questions about GTM workspaces — what tags fire on a trigger, what references a variable, what custom code touches a string, what changed vs. the live version. It reads by default; it can also edit a workspace through `gallium apply` (see [Writing](#writing)), and it can never publish.

## Install

> **Upgrading from v0.1.x:** the local cache schema changed, so existing caches are discarded on first
> use — run `gallium container pull <alias>` once per container. Entity commands also moved to noun groups
> (`gallium tags list`, not `gallium list tags`); the old spellings still work but warn. See
> [Deprecated commands](#deprecated-commands). Re-run `gallium skill install` to refresh the Claude skill.

### Homebrew (recommended)

```bash
brew install tyssejc/tap/gallium
```

Then enable the Claude Code skill:

```bash
gallium skill install
```

### From source (bun required)

```bash
git clone https://github.com/tyssejc/gallium.git
cd gallium
bun install
bun link          # makes 'gallium' available globally
```

## Setup

### 1. Create the config file

```bash
gallium container init
```

This writes a starter config to `~/.config/gallium/config.toml` (respects `$XDG_CONFIG_HOME`).

### 2. Edit the config

Open `~/.config/gallium/config.toml` and fill in your OAuth client credentials.

#### OAuth (default)

```toml
[oauth]
client_id = "your-client-id.apps.googleusercontent.com"
client_secret = "${env:GALLIUM_OAUTH_SECRET}"   # reads from env var; a Desktop-app secret may also be pasted as a literal

[containers."acme/web"]
account_id = "123456"
container_id = "7891011"
workspace_id = "3"
```

Set the env var before running commands:

```bash
export GALLIUM_OAUTH_SECRET="your-secret"
```

After filling in `[oauth]`, run login once to authorize and cache the refresh token:

```bash
gallium login
```

This opens a browser to complete the OAuth flow and saves the refresh token to `~/.cache/gallium/.tokens/`. One login covers every container you can access. When Google shows a "Google hasn't verified this app" screen (expected for an app in Testing mode), click **Advanced** → **Go to … (unsafe)** to proceed.

#### Service account (headless/CI)

For automated or headless environments, add a `[service_account]` block instead of (or alongside) `[oauth]`:

```toml
[service_account]
key_file = "/path/to/service-account.json"

[containers."acme/web"]
account_id = "123456"
container_id = "7891011"
workspace_id = "3"
```

The service account must have the **GTM Reader** role (or higher) on the account. When a service account is configured and no OAuth token is present, gallium falls back to it automatically.

### 3. Discover and register containers

Rather than hand-entering account/container/workspace IDs, use the discovery commands to look them up from the API:

```bash
gallium accounts                                       # list GTM accounts you can see
gallium containers                                     # list all containers across your accounts
gallium containers <accountId>                         # list containers for one account
gallium workspaces <accountId> <containerId>           # list workspaces in a container
gallium container add acme/web <accountId> <containerId> <workspaceId>   # save an alias
```

See the [Discovering containers](#discovering-containers) section below for details.

### 4. Set the default container

```bash
gallium container use acme/web
```

After this, all commands default to `acme/web`. Override per-command with `-c <alias>`.

### 5. Pull the container

```bash
gallium container pull acme/web
```

This fetches all tags, triggers, variables, and folders from the GTM API and stores them in a local SQLite cache (`~/.cache/gallium/acme/web.db`). You must pull before running analysis commands. Re-pull any time you want fresh data.

## Commands

### Auth

```bash
gallium login                            # OAuth: open browser, cache refresh token (run once; covers all containers)
```

### Discovery

```bash
gallium accounts                         # list GTM accounts (account_id, name)
gallium containers [<accountId>]         # list containers across all accounts, or one account
gallium workspaces <accountId> <containerId>   # list workspaces in a container
```

### Container management

```bash
gallium container init                   # write starter config
gallium container add <alias> <accountId> <containerId> <workspaceId>   # save an alias from discovered IDs
gallium container use <alias>            # set default container
gallium container pull <alias>           # pull workspace into local cache
gallium container status [-c <alias>]    # show alias + last_pulled_at
gallium container list                   # list all configured containers
gallium container show [-c <alias>]      # show resolved config for default/selected container
```

### Analysis commands

All analysis commands operate on the local cache. Pass `--json` for machine-readable output.
The only network request they can make is the one-time fetch of a version snapshot named by an
`@ref` (see below); against a plain workspace alias they make none.

```bash
gallium tags list [--type html] [--folder <ID>] [--paused] [--json] [-c <alias>]
gallium triggers list [--json] [-c <alias>]
gallium variables list [--unused] [--json] [-c <alias>]
gallium folders list [--json] [-c <alias>]
# List workspace entities. --unused shows variables referenced nowhere.

gallium tags get '<Tag Name>' [--json] [-c <alias>]
gallium triggers get '<Trigger Name>' [--json] [-c <alias>]
gallium variables get '<Variable Name>' [--json] [-c <alias>]
# The entity's full raw JSON — every parameter, mapping, and setting. The noun
# carries the kind, so a name shared by a tag and a variable is unambiguous.

gallium variables refs '<Variable Name>' [--json] [-c <alias>]
# Every tag/trigger/variable whose parameters or custom code reference {{Variable Name}}.

gallium tags triggers '<Tag Name>' [--json] [-c <alias>]
# Which triggers fire the tag and which block it.

gallium triggers tags '<Trigger Name>' [--json] [-c <alias>]
# Which tags the trigger fires and which it blocks.

gallium code search '<pattern>' [--json] [-c <alias>]
# Full-text search across all custom HTML, custom JS, and template fields.

gallium diff [--json] [-c <alias>]
# Entities added/updated/deleted in the working workspace vs. the live container version
# (uses the GTM API's own workspace status).

gallium dirty [--json] [-c <alias>]
# Edited-but-unpublished and/or paused entities in the working workspace.

```

### Versions & environments

```bash
gallium environments list [--json] [-c <alias>]
# Every environment (Live, Latest, Dev, …) and the version it currently points at.

gallium versions list [--limit <n>] [--dates] [--json] [-c <alias>]
# Published versions, newest first. Default limit 20.
# --dates adds created_at, at the cost of one full version fetch per row.

gallium versions get <versionId|env:name|live|latest> [--json] [-c <alias>]
# Prefetch a version snapshot and print its name, description, creation date,
# entity counts, and what it resolved to.

gallium diff --against <versionId|env:name|live|latest> [--json] [-c <alias>]
# Compare against something other than live. Empty output means the two sides match.
```

Any `-c` value accepts an `@` suffix naming an immutable snapshot — `@v42`, `@live` (newest published),
or `@latest` (newest version, published or not) — and every analysis command honours it:

```bash
gallium tags list -c acme/web@live          # the tags as actually published
gallium tags get 'My Tag' -c acme/web@v42   # that tag's config in version 42
gallium diff -c acme/web@v41 --against 42   # what changed between two publishes
```

Snapshots are fetched automatically on first use and cached permanently, since a version never changes.

`created_at` comes from the version's `fingerprint`, which GTM recomputes whenever the version is written.
It therefore dates creation or last modification, not publication — renaming an old version moves its date.
For what is actually deployed to an environment, use `gallium environments list`.

### Writes

```bash
gallium login --write                    # OAuth with the edit scope (opt-in)
gallium apply <spec.json> -c <alias> --workspace <name|new:Title> [--commit] [--json]
```

See [Writing](#writing).

### Skill install

```bash
gallium skill install   # copy skill files into ~/.claude/skills/gallium/
gallium skill path      # print the install directory path
```

Installs the `gallium` Claude skill into `~/.claude/skills/gallium/` (respects `$CLAUDE_CONFIG_DIR`). This lets Claude Code use `gallium` to answer GTM questions automatically.

## Writing

Writing is opt-in. A plain `gallium login` is read-only; `gallium login --write` additionally requests the `tagmanager.edit.containers` scope. Service-account auth never writes.

```bash
gallium login --write
gallium apply spec.json -c acme/web --workspace "new:GPC signal"            # dry run: prints the plan, sends nothing
gallium apply spec.json -c acme/web --workspace "new:GPC signal" --commit   # applies it
```

`spec.json` is a JSON array of tag, trigger, variable and folder entries to create, patch or delete. `-c` and `--workspace` are mandatory; gallium never falls back to the default container or workspace. `new:<Title>` creates a workspace (or reuses one with that title). After `--commit` gallium re-reads the workspace and confirms every change landed.

Gallium never publishes, creates versions or previews: that stays a human step in the GTM UI, so every write is discardable with its workspace. Every request is paced to 20 per 100 s across invocations. The spec format, validation rules and scope caveats are in the [design](docs/superpowers/specs/2026-11-20-write-ops-design.md) and in the skill (`src/skill/SKILL.md`).

## Discovering containers

After running `gallium login`, use these commands to find the IDs you need before hand-editing config:

```bash
# 1. See which GTM accounts you can access
gallium accounts --json

# 2. List all containers (or scope to one account)
gallium containers --json
gallium containers 123456 --json

# 3. List workspaces inside a container
gallium workspaces 123456 7891011 --json

# 4. Register an alias using the IDs you found
gallium container add acme/web 123456 7891011 3
```

From there, `gallium container use acme/web` and `gallium container pull acme/web` complete the setup.

## Question → command reference

### Discovery

| User asks | Command |
|---|---|
| What GTM accounts can I see? | `gallium accounts --json` |
| What containers do I have access to? | `gallium containers --json` |
| Containers for a specific account | `gallium containers <accountId> --json` |
| What workspaces exist in a container? | `gallium workspaces <accountId> <containerId> --json` |

### Analysis

| User asks | Command |
|---|---|
| What references `{{Variable Z}}`? | `gallium variables refs 'Variable Z' --json` |
| What triggers does tag Y fire on? | `gallium tags triggers 'Y' --json` |
| What tags fire on trigger T? | `gallium triggers tags 'T' --json` |
| Full config of tag/trigger/variable X | `gallium tags get 'X' --json` |
| Find custom code touching `dataLayer.foo` | `gallium code search 'dataLayer.foo' --json` |
| What changed vs. the live version? | `gallium diff --json` |
| Anything edited-but-unpublished / paused? | `gallium dirty --json` |
| List tags / triggers / variables / folders | `gallium tags list [--type html] [--folder ID] [--paused] --json` |
| Variables referenced nowhere | `gallium variables list --unused --json` |

### Versions & environments

| User asks | Command |
|---|---|
| What version is published to Dev / Live? | `gallium environments list --json` |
| What versions exist? | `gallium versions list [--limit N] --json` |
| Details of version N | `gallium versions get N --json` |
| When was each version created? | `gallium versions list --dates --json` |
| Does my workspace match what's on Dev? | `gallium diff --against env:dev --json` |
| What changed between two publishes? | `gallium diff -c <alias>@v41 --against 42 --json` |
| Inspect a published version's config | any analysis command with `-c <alias>@v42` |

## Flags

| Flag | Short | Description |
|---|---|---|
| `--json` | | Output as JSON |
| `--container <alias>` | `-c` | Override the default container |
| `--type <type>` | | Filter by entity type (e.g. `html`) |
| `--folder <id>` | | Filter by folder ID |
| `--paused` | | Show only paused entities |
| `--unused` | | Show only variables referenced nowhere |
| `--against <target>` | | Diff against `<versionId>`, `env:<name>`, `live`, or `latest` |
| `--limit <n>` | | Max rows for `gallium versions list` (default 20) |
| `--dates` | | Add `created_at` to `gallium versions list` (one fetch per row) |
| `--write` | | With `gallium login`: also request the edit scope |
| `--workspace <name\|new:Title>` | | Target workspace for `gallium apply` (required) |
| `--commit` | | Apply the plan; without it `gallium apply` is a dry run |

## Deprecated commands

The pre-v0.3.0 spellings still work and still print the same thing on stdout, but warn on stderr and no
longer appear in `--help`. They will be removed in a future release.

| Deprecated | Use |
|---|---|
| `gallium list <kind>` | `gallium <kind> list` |
| `gallium show 'X' [--kind K]` | `gallium <K>s get 'X'` |
| `gallium tag 'X'` | `gallium tags triggers 'X'` |
| `gallium trigger 'X'` | `gallium triggers tags 'X'` |
| `gallium refs 'X'` | `gallium variables refs 'X'` |
| `gallium versions show <id>` | `gallium versions get <id>` |

The warning goes to stderr, so `--json` output stays parseable while you migrate. If you see one coming
from Claude Code, the installed skill is stale — refresh it with `gallium skill install`.

## License

MIT
