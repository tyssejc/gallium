import type { Cmd } from "../command.ts";
import { configPath, statePath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { loadState, saveState } from "../config/state.ts";
import { openDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { GtmClient } from "../gtm/client.ts";
import { getUserToken } from "../auth/token.ts";
import { pullWorkspace } from "../pull/pull.ts";
import { resolveAlias, requireWorkspaceAlias } from "./_shared.ts";
import { format } from "../output.ts";
import { ensureDirFor } from "../util/fs.ts";

const TEMPLATE = `# gallium config
#
# [oauth]                    # run \`gallium login\` after filling these
#   client_id = "..."
#   client_secret = "\${env:GALLIUM_OAUTH_SECRET}"   # or a literal
#
# [service_account]          # optional, for headless/CI use
#   key_file = "/path/sa.json"
#
# [containers."<alias>"]     # add with \`gallium container add <alias> <accountId> <containerId> <workspaceId>\`
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
  if (!positionals[0]) throw new Error("usage: gallium container use <alias>");
  const alias = requireWorkspaceAlias(positionals[0]);
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
  const rows = Object.entries(cfg.containers).map(([alias, c]) => ({ alias,
    account_id: c.account_id, container_id: c.container_id, workspace_id: c.workspace_id }));
  console.log(format(rows, { json: !!flags.json, columns: ["alias", "account_id", "container_id", "workspace_id"] }));
  return 0;
};

export const cmdContainerShow: Cmd = async (_p, flags) => {
  const alias = requireWorkspaceAlias(await resolveAlias(flags));
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  console.log(format({ alias: r.alias, accountId: r.accountId,
    containerId: r.containerId, workspaceId: r.workspaceId }, { json: !!flags.json }));
  return 0;
};

export const cmdContainerStatus: Cmd = async (_p, flags) => {
  const alias = requireWorkspaceAlias(await resolveAlias(flags));
  const cfg = await loadConfig(configPath());
  resolveContainer(cfg, alias);
  const db = await openDb(alias);
  const lastPulled = getMeta(db, "last_pulled_at");
  console.log(format({ alias, last_pulled_at: lastPulled ?? null }, { json: !!flags.json }));
  return 0;
};

export const cmdContainerAdd: Cmd = async (positionals) => {
  const [alias, accountId, containerId, workspaceId] = positionals;
  if (!alias || !accountId || !containerId || !workspaceId)
    throw new Error("usage: gallium container add <alias> <accountId> <containerId> <workspaceId>");
  requireWorkspaceAlias(alias);
  const path = configPath();
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`No config at ${path}. Run 'gallium container init' first.`);
  const existing = await loadConfig(path);
  if (existing.containers[alias]) throw new Error(`Container alias '${alias}' already exists.`);
  const block = `\n[containers."${alias}"]\naccount_id = "${accountId}"\ncontainer_id = "${containerId}"\nworkspace_id = "${workspaceId}"\n`;
  await Bun.write(path, (await file.text()) + block);
  console.log(`Added container '${alias}'.`);
  return 0;
};

export const cmdContainerPull: Cmd = async (positionals, flags) => {
  const alias = requireWorkspaceAlias(positionals[0] ?? await resolveAlias(flags));
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  const token = await getUserToken(cfg);
  const client = new GtmClient(token);
  const db = await openDb(alias);
  const ws = client.wsPath(r.accountId, r.containerId, r.workspaceId);
  await pullWorkspace(db, client, ws, new Date().toISOString());
  console.log(`Pulled '${alias}'.`);
  return 0;
};
