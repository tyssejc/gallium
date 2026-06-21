# gallium

Read-only Google Tag Manager container analysis CLI. Answers questions about GTM workspaces — what tags fire on a trigger, what references a variable, what custom code touches a string, what changed vs. the live version — without modifying anything.

## Install

### Homebrew (recommended)

```bash
brew tap tyssejc/gallium https://github.com/tyssejc/gallium
brew install gallium
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

All analysis commands operate on the local cache and make no network requests. Pass `--json` for machine-readable output.

```bash
gallium refs '<Variable Name>' [--json] [-c <alias>]
# Every tag/trigger/variable whose parameters or custom code reference {{Variable Name}}.

gallium tag '<Tag Name>' [--json] [-c <alias>]
# The tag's details plus which triggers fire it and which block it.

gallium trigger '<Trigger Name>' [--json] [-c <alias>]
# The trigger's details plus which tags it fires and which it blocks.

gallium code search '<pattern>' [--json] [-c <alias>]
# Full-text search across all custom HTML, custom JS, and template fields.

gallium diff [--json] [-c <alias>]
# Entities added/updated/deleted in the working workspace vs. the live container version
# (uses the GTM API's own workspace status).

gallium dirty [--json] [-c <alias>]
# Edited-but-unpublished and/or paused entities in the working workspace.

gallium list tags [--type html] [--folder <ID>] [--paused] [--json] [-c <alias>]
gallium list triggers [--json] [-c <alias>]
gallium list variables [--unused] [--json] [-c <alias>]
gallium list folders [--json] [-c <alias>]
# List workspace entities. --unused shows variables referenced nowhere.
```

### Skill install

```bash
gallium skill install   # copy skill files into ~/.claude/skills/gallium/
gallium skill path      # print the install directory path
```

Installs the `gallium` Claude skill into `~/.claude/skills/gallium/` (respects `$CLAUDE_CONFIG_DIR`). This lets Claude Code use `gallium` to answer GTM questions automatically.

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
| What references `{{Variable Z}}`? | `gallium refs 'Variable Z' --json` |
| What triggers does tag Y fire on? | `gallium tag 'Y' --json` |
| What tags fire on trigger T? | `gallium trigger 'T' --json` |
| Find custom code touching `dataLayer.foo` | `gallium code search 'dataLayer.foo' --json` |
| What changed vs. the live version? | `gallium diff --json` |
| Anything edited-but-unpublished / paused? | `gallium dirty --json` |
| List tags / triggers / variables / folders | `gallium list tags [--type html] [--folder ID] [--paused] --json` |
| Variables referenced nowhere | `gallium list variables --unused --json` |

## Flags

| Flag | Short | Description |
|---|---|---|
| `--json` | | Output as JSON |
| `--container <alias>` | `-c` | Override the default container |
| `--type <type>` | | Filter by entity type (e.g. `html`) |
| `--folder <id>` | | Filter by folder ID |
| `--paused` | | Show only paused entities |
| `--unused` | | Show only variables referenced nowhere |

## License

MIT
