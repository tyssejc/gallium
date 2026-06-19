import { parse as parseToml } from "smol-toml";

export type AccountAuth =
  | { mode: "oauth"; client_id: string; client_secret: string }
  | { mode: "service_account"; key_file: string };

export interface ContainerConfig {
  account: string; account_id: string; container_id: string; workspace_id: string;
}
export interface Config {
  accounts: Record<string, AccountAuth>;
  containers: Record<string, ContainerConfig>;
}
export interface ResolvedContainer {
  alias: string; accountId: string; containerId: string; workspaceId: string;
  account: AccountAuth; accountName: string;
}

const ENV_RE = /\$\{env:([A-Z0-9_]+)\}/g;
function substitute(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_RE, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Config references missing env var: ${name}`);
    return v;
  });
}

export function parseConfig(toml: string, env: Record<string, string | undefined> = process.env): Config {
  const raw = parseToml(toml) as any;
  const accounts: Record<string, AccountAuth> = {};
  for (const [name, a] of Object.entries(raw.accounts ?? {})) {
    const acct = a as any;
    if (acct.mode === "service_account") {
      accounts[name] = { mode: "service_account", key_file: acct.key_file };
    } else {
      accounts[name] = {
        mode: "oauth",
        client_id: acct.client_id,
        client_secret: substitute(acct.client_secret ?? "", env),
      };
    }
  }
  const containers: Record<string, ContainerConfig> = {};
  for (const [alias, c] of Object.entries(raw.containers ?? {})) {
    const cc = c as any;
    containers[alias] = {
      account: cc.account, account_id: String(cc.account_id),
      container_id: String(cc.container_id), workspace_id: String(cc.workspace_id),
    };
  }
  return { accounts, containers };
}

export function resolveContainer(cfg: Config, alias: string): ResolvedContainer {
  const c = cfg.containers[alias];
  if (!c) {
    const available = Object.keys(cfg.containers).join(", ") || "(none configured)";
    throw new Error(`Unknown container alias '${alias}'. Available: ${available}`);
  }
  const account = cfg.accounts[c.account];
  if (!account) throw new Error(`Container '${alias}' references undefined account '${c.account}'`);
  return {
    alias, accountId: c.account_id, containerId: c.container_id, workspaceId: c.workspace_id,
    account, accountName: c.account,
  };
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`No config at ${path}. Run 'gallium container init' to create one.`);
  return parseConfig(await file.text(), env);
}
