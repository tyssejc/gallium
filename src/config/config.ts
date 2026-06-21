import { parse as parseToml } from "smol-toml";

export interface OAuthConfig { client_id: string; client_secret: string; }
export interface ServiceAccountConfig { key_file: string; }
export interface ContainerConfig { account_id: string; container_id: string; workspace_id: string; }
export interface Config {
  oauth?: OAuthConfig;
  serviceAccount?: ServiceAccountConfig;
  containers: Record<string, ContainerConfig>;
}
export interface ResolvedContainer {
  alias: string; accountId: string; containerId: string; workspaceId: string;
}

function substitute(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Config references missing env var: ${name}`);
    return v;
  });
}

export function parseConfig(toml: string, env: Record<string, string | undefined> = process.env): Config {
  const raw = parseToml(toml) as any;
  let oauth: OAuthConfig | undefined;
  if (raw.oauth) {
    oauth = { client_id: String(raw.oauth.client_id ?? ""), client_secret: substitute(String(raw.oauth.client_secret ?? ""), env) };
  }
  let serviceAccount: ServiceAccountConfig | undefined;
  if (raw.service_account) {
    serviceAccount = { key_file: substitute(String(raw.service_account.key_file ?? ""), env) };
  }
  const containers: Record<string, ContainerConfig> = {};
  for (const [alias, c] of Object.entries(raw.containers ?? {})) {
    const cc = c as any;
    containers[alias] = {
      account_id: String(cc.account_id), container_id: String(cc.container_id), workspace_id: String(cc.workspace_id),
    };
  }
  return { oauth, serviceAccount, containers };
}

export function resolveContainer(cfg: Config, alias: string): ResolvedContainer {
  const c = cfg.containers[alias];
  if (!c) {
    const available = Object.keys(cfg.containers).join(", ") || "(none configured)";
    throw new Error(`Unknown container alias '${alias}'. Available: ${available}`);
  }
  return { alias, accountId: c.account_id, containerId: c.container_id, workspaceId: c.workspace_id };
}

export async function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`No config at ${path}. Run 'gallium container init' to create one.`);
  return parseConfig(await file.text(), env);
}
