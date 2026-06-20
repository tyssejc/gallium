import type { Cmd } from "../command.ts";
import { configPath, statePath, tokenCachePath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { loadState, saveState } from "../config/state.ts";
import { openDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { GtmClient } from "../gtm/client.ts";
import { getAccountToken } from "../auth/token.ts";
import { loginOAuth } from "../auth/oauth.ts";
import { pullContainer } from "../pull/pull.ts";
import { resolveAlias } from "./_shared.ts";
import { format } from "../output.ts";
import { ensureDirFor } from "../util/fs.ts";
import { chmod } from "node:fs/promises";

const TEMPLATE = `# gallium config
# [accounts.<name>]
#   mode = "oauth"            # or "service_account"
#   client_id = "..."        # oauth only
#   client_secret = "\${env:GALLIUM_OAUTH_SECRET}"
#   key_file = "/path/sa.json"  # service_account only
#
# [containers."<alias>"]
#   account = "<name>"
#   account_id = "123"
#   container_id = "456"
#   workspace_id = "7"
`;

export const cmdContainerInit: Cmd = async () => {
  const path = configPath();
  if (await Bun.file(path).exists()) { console.error(`Config already exists at ${path}`); return 1; }
  await ensureDirFor(path);
  await Bun.write(path, TEMPLATE);
  console.log(`Wrote starter config to ${path}. Edit it to add an account and container.`);
  return 0;
};

export const cmdContainerUse: Cmd = async (positionals) => {
  const alias = positionals[0];
  if (!alias) throw new Error("usage: gallium container use <alias>");
  const cfg = await loadConfig(configPath());
  resolveContainer(cfg, alias); // validates
  const sp = statePath();
  const state = await loadState(sp);
  await saveState(sp, { ...state, default_container: alias });
  console.log(`Default container set to '${alias}'.`);
  return 0;
};

export const cmdContainerList: Cmd = async (_p, flags) => {
  const cfg = await loadConfig(configPath());
  const rows = Object.entries(cfg.containers).map(([alias, c]) => ({ alias, account: c.account,
    account_id: c.account_id, container_id: c.container_id, workspace_id: c.workspace_id }));
  console.log(format(rows, { json: !!flags.json, columns: ["alias", "account", "account_id", "container_id", "workspace_id"] }));
  return 0;
};

export const cmdContainerShow: Cmd = async (_p, flags) => {
  const alias = await resolveAlias(flags);
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  console.log(format({ alias: r.alias, account: r.accountName, accountId: r.accountId,
    containerId: r.containerId, workspaceId: r.workspaceId, authMode: r.account.mode }, { json: !!flags.json }));
  return 0;
};

export const cmdContainerLogin: Cmd = async (positionals, flags) => {
  const alias = positionals[0] ?? await resolveAlias(flags);
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  if (r.account.mode !== "oauth") {
    throw new Error(`Account '${r.accountName}' uses ${r.account.mode} auth; 'login' is only for oauth accounts.`);
  }
  const refreshToken = await loginOAuth(r.account.client_id, r.account.client_secret);
  const refreshPath = `${tokenCachePath(r.accountName)}.refresh`;
  await ensureDirFor(refreshPath);
  await Bun.write(refreshPath, refreshToken);
  await chmod(refreshPath, 0o600);
  console.log(`Logged in account '${r.accountName}'. Refresh token saved.`);
  return 0;
};

export const cmdContainerStatus: Cmd = async (_p, flags) => {
  const alias = await resolveAlias(flags);
  const cfg = await loadConfig(configPath());
  resolveContainer(cfg, alias);
  const db = await openDb(alias);
  const lastPulled = getMeta(db, "last_pulled_at");
  console.log(format({ alias, last_pulled_at: lastPulled ?? null }, { json: !!flags.json }));
  return 0;
};

export const cmdContainerPull: Cmd = async (positionals, flags) => {
  const alias = positionals[0] ?? await resolveAlias(flags);
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  const token = await getAccountToken(r.accountName, r.account);
  const client = new GtmClient(token);
  const db = await openDb(alias);
  const ws = client.wsPath(r.accountId, r.containerId, r.workspaceId);
  await pullContainer(db, client, ws, new Date().toISOString());
  console.log(`Pulled '${alias}'.`);
  return 0;
};
