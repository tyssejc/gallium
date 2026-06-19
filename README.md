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

Open `~/.config/gallium/config.toml` and add your account and container.

#### OAuth (default)

```toml
[accounts.myaccount]
mode = "oauth"
client_id = "your-client-id.apps.googleusercontent.com"
client_secret = "${env:GALLIUM_OAUTH_SECRET}"   # reads from env var

[containers."acme/web"]
account = "myaccount"
account_id = "123456"
container_id = "7891011"
workspace_id = "3"
```

Set the env var before running commands:

```bash
export GALLIUM_OAUTH_SECRET="your-secret"
```

After configuring an OAuth account, run the login command once to authorize and store the refresh token:

```bash
gallium container login acme/web
```

This opens a browser to complete the OAuth flow and saves the refresh token to `~/.cache/gallium/.tokens/`. You only need to do this once per account.

#### Service account

```toml
[accounts.myaccount]
mode = "service_account"
key_file = "/path/to/service-account.json"

[containers."acme/web"]
account = "myaccount"
account_id = "123456"
container_id = "7891011"
workspace_id = "3"
```

The service account must have the **GTM Reader** role (or higher) on the account.

### 3. Set the default container

```bash
gallium container use acme/web
```

After this, all commands default to `acme/web`. Override per-command with `-c <alias>`.

### 4. Pull the container

```bash
gallium container pull acme/web
```

This fetches all tags, triggers, variables, and folders from the GTM API and stores them in a local SQLite cache (`~/.cache/gallium/acme/web.db`). You must pull before running analysis commands. Re-pull any time you want fresh data.

## Commands

### Container management

```bash
gallium container init                   # write starter config
gallium container use <alias>            # set default container
gallium container login <alias>          # OAuth accounts: authorize and store refresh token (run once before first pull)
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

## Question → command reference

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
