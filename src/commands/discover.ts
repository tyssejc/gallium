import type { Cmd } from "../command.ts";
import { configPath } from "../paths.ts";
import { loadConfig } from "../config/config.ts";
import { getUserToken } from "../auth/token.ts";
import type { GtmClient } from "../gtm/client.ts";
import { liveClient } from "../gtm/live.ts";
import { format } from "../output.ts";

async function client(): Promise<GtmClient> {
  const cfg = await loadConfig(configPath());
  return liveClient(await getUserToken(cfg));
}

// gallium accounts
export const cmdAccounts: Cmd = async (_pos, flags) => {
  const accounts = await (await client()).listAccounts();
  const rows = accounts.map((a) => ({ account_id: a.accountId, name: a.name }));
  console.log(format(rows, { json: !!flags.json, columns: ["account_id", "name"] }));
  return 0;
};

// gallium containers [<accountId>]
export const cmdContainers: Cmd = async (positionals, flags) => {
  const c = await client();
  const accountId = positionals[0];
  const accountIds = accountId ? [accountId] : (await c.listAccounts()).map((a) => a.accountId);
  const rows: { account_id: string; container_id: string; name: string; public_id: string }[] = [];
  for (const aid of accountIds) {
    for (const ct of await c.listContainers(aid)) {
      rows.push({ account_id: ct.accountId, container_id: ct.containerId, name: ct.name, public_id: ct.publicId ?? "" });
    }
  }
  console.log(format(rows, { json: !!flags.json, columns: ["account_id", "container_id", "name", "public_id"] }));
  return 0;
};

// gallium workspaces <accountId> <containerId>
export const cmdWorkspaces: Cmd = async (positionals, flags) => {
  const accountId = positionals[0]; const containerId = positionals[1];
  if (!accountId || !containerId) throw new Error("usage: gallium workspaces <accountId> <containerId>");
  const ws = await (await client()).listWorkspaces(accountId, containerId);
  const rows = ws.map((w) => ({ workspace_id: w.workspaceId, name: w.name }));
  console.log(format(rows, { json: !!flags.json, columns: ["workspace_id", "name"] }));
  return 0;
};
