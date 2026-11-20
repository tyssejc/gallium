import type {
  GtmTag, GtmTrigger, GtmVariable, GtmBuiltInVariable, GtmFolder, GtmTemplate, WorkspaceStatus,
  GtmAccount, GtmContainer, GtmWorkspace, GtmEnvironment, GtmVersionHeader, GtmContainerVersion,
} from "./types.ts";

import { isQuotaError, type Pacer } from "./pace.ts";

const BASE = "https://tagmanager.googleapis.com/tagmanager/v2";
const MAX_ATTEMPTS = 5;

export interface GtmClientOpts {
  pacer?: Pacer;
  sleep?: (ms: number) => Promise<void>;
}

export class GtmClient {
  private pacer?: Pacer;
  private sleep: (ms: number) => Promise<void>;

  constructor(private token: string, private fetchFn: typeof fetch = fetch, opts: GtmClientOpts = {}) {
    this.pacer = opts.pacer;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  wsPath(accountId: string, containerId: string, workspaceId: string): string {
    return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  // Paced fetch with retry on quota errors (429 / quota 403). Returns parsed JSON, or undefined for an empty body.
  protected async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<any> {
    const qs = new URLSearchParams(opts.query ?? {}).toString();
    const url = `${BASE}/${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = this.headers();
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    for (let attempt = 0; ; attempt++) {
      await this.pacer?.acquire();
      const res = await this.fetchFn(url, init);
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : undefined;
      }
      const body = await res.text();
      if (attempt + 1 >= MAX_ATTEMPTS || !isQuotaError(res.status, body)) {
        throw new Error(`GTM ${method} ${path} failed (${res.status}): ${body}`);
      }
      const retryAfter = Number(res.headers.get("Retry-After"));
      await this.sleep(retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60_000, 2_000 * 2 ** attempt) + Math.random() * 1000);
    }
  }

  private getJson(path: string, query: Record<string, string> = {}): Promise<any> {
    return this.request("GET", path, { query });
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

  containerPath(accountId: string, containerId: string): string {
    return `accounts/${accountId}/containers/${containerId}`;
  }

  listEnvironments(accountId: string, containerId: string): Promise<GtmEnvironment[]> {
    return this.listAll(`${this.containerPath(accountId, containerId)}/environments`, "environment");
  }
  listVersionHeaders(accountId: string, containerId: string): Promise<GtmVersionHeader[]> {
    return this.listAll(`${this.containerPath(accountId, containerId)}/version_headers`, "containerVersionHeader");
  }
  getVersion(accountId: string, containerId: string, versionId: string): Promise<GtmContainerVersion> {
    return this.getJson(`${this.containerPath(accountId, containerId)}/versions/${versionId}`);
  }
  getLiveVersion(accountId: string, containerId: string): Promise<GtmContainerVersion> {
    return this.getJson(`${this.containerPath(accountId, containerId)}/versions:live`);
  }
  getLatestVersionHeader(accountId: string, containerId: string): Promise<GtmVersionHeader> {
    return this.getJson(`${this.containerPath(accountId, containerId)}/version_headers:latest`);
  }
}
