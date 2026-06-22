import type {
  GtmTag, GtmTrigger, GtmVariable, GtmBuiltInVariable, GtmFolder, GtmTemplate, WorkspaceStatus,
  GtmAccount, GtmContainer, GtmWorkspace,
} from "./types.ts";

const BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

export class GtmClient {
  constructor(private token: string, private fetchFn: typeof fetch = fetch) {}

  wsPath(accountId: string, containerId: string, workspaceId: string): string {
    return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  private async getJson(path: string, query: Record<string, string> = {}): Promise<any> {
    const qs = new URLSearchParams(query).toString();
    const url = `${BASE}/${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`GTM GET ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  // Pages through `nextPageToken`, collecting the array under `field`.
  private async listAll<T>(path: string, field: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const body = await this.getJson(path, pageToken ? { pageToken } : {});
      if (Array.isArray(body[field])) out.push(...body[field]);
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  listTags(ws: string): Promise<GtmTag[]> { return this.listAll(`${ws}/tags`, "tag"); }
  listTriggers(ws: string): Promise<GtmTrigger[]> { return this.listAll(`${ws}/triggers`, "trigger"); }
  listVariables(ws: string): Promise<GtmVariable[]> { return this.listAll(`${ws}/variables`, "variable"); }
  listBuiltInVariables(ws: string): Promise<GtmBuiltInVariable[]> { return this.listAll(`${ws}/built_in_variables`, "builtInVariable"); }
  listFolders(ws: string): Promise<GtmFolder[]> { return this.listAll(`${ws}/folders`, "folder"); }
  listTemplates(ws: string): Promise<GtmTemplate[]> { return this.listAll(`${ws}/templates`, "template"); }

  getStatus(ws: string): Promise<WorkspaceStatus> { return this.getJson(`${ws}/status`); }

  listAccounts(): Promise<GtmAccount[]> { return this.listAll("accounts", "account"); }
  listContainers(accountId: string): Promise<GtmContainer[]> { return this.listAll(`accounts/${accountId}/containers`, "container"); }
  listWorkspaces(accountId: string, containerId: string): Promise<GtmWorkspace[]> { return this.listAll(`accounts/${accountId}/containers/${containerId}/workspaces`, "workspace"); }
}
