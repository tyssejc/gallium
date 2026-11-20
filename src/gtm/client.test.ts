import { test, expect } from "bun:test";
import { GtmClient } from "./client.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("listTags follows nextPageToken, concatenates, and sends a Bearer header", async () => {
  const calls: string[] = [];
  const seenAuths: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    seenAuths.push((init?.headers as Record<string, string>)?.Authorization ?? "");
    if (url.includes("pageToken=p2")) return jsonResponse({ tag: [{ tagId: "2", name: "B" }] });
    return jsonResponse({ tag: [{ tagId: "1", name: "A" }], nextPageToken: "p2" });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  const ws = client.wsPath("111", "222", "3");
  const tags = await client.listTags(ws);
  expect(tags.map((t) => t.tagId)).toEqual(["1", "2"]);
  expect(calls[0]).toContain("/accounts/111/containers/222/workspaces/3/tags");
  expect(seenAuths.length).toBe(2);
  expect(seenAuths.every((a) => a === "Bearer tok")).toBe(true);
});

test("non-2xx throws with status and body", async () => {
  const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  await expect(client.listTags("accounts/1/containers/2/workspaces/3")).rejects.toThrow(/403/);
});

test("listContainers hits accounts/<id>/containers and extracts container field", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ container: [{ accountId: "111", containerId: "222", name: "My Container", publicId: "GTM-ABC" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  const containers = await client.listContainers("111");
  expect(calls[0]).toContain("accounts/111/containers");
  expect(containers).toHaveLength(1);
  expect(containers[0]!.containerId).toBe("222");
  expect(containers[0]!.name).toBe("My Container");
  expect(containers[0]!.publicId).toBe("GTM-ABC");
});

test("listWorkspaces hits accounts/<id>/containers/<id>/workspaces and extracts workspace field", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ workspace: [{ workspaceId: "3", name: "Default Workspace" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  const ws = await client.listWorkspaces("111", "222");
  expect(calls[0]).toContain("accounts/111/containers/222/workspaces");
  expect(ws).toHaveLength(1);
  expect(ws[0]!.workspaceId).toBe("3");
  expect(ws[0]!.name).toBe("Default Workspace");
});

test("listWorkspaces follows nextPageToken across two pages", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.includes("pageToken=p2")) {
      return new Response(JSON.stringify({ workspace: [{ workspaceId: "4", name: "WS 2" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ workspace: [{ workspaceId: "3", name: "WS 1" }], nextPageToken: "p2" }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  const ws = await client.listWorkspaces("111", "222");
  expect(ws.map((w) => w.workspaceId)).toEqual(["3", "4"]);
  expect(calls).toHaveLength(2);
});

test("listEnvironments hits containers/<id>/environments and extracts environment field", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ environment: [
      { environmentId: "1", name: "Live", type: "live", containerVersionId: "42" },
      { environmentId: "3", name: "Dev", type: "user", containerVersionId: "41" },
    ] });
  }) as unknown as typeof fetch;
  const envs = await new GtmClient("tok", fetchFn).listEnvironments("111", "222");
  expect(calls[0]).toContain("accounts/111/containers/222/environments");
  expect(envs.map((e) => e.name)).toEqual(["Live", "Dev"]);
  expect(envs[1]!.containerVersionId).toBe("41");
});

test("listVersionHeaders extracts containerVersionHeader and follows nextPageToken", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (url.includes("pageToken=p2")) {
      return jsonResponse({ containerVersionHeader: [{ containerVersionId: "41", name: "older" }] });
    }
    return jsonResponse({
      containerVersionHeader: [{ containerVersionId: "42", name: "newest", numTags: "9" }],
      nextPageToken: "p2",
    });
  }) as unknown as typeof fetch;
  const headers = await new GtmClient("tok", fetchFn).listVersionHeaders("111", "222");
  expect(calls[0]).toContain("accounts/111/containers/222/version_headers");
  expect(headers.map((h) => h.containerVersionId)).toEqual(["42", "41"]);
  expect(headers[0]!.numTags).toBe("9");
});

test("getVersion fetches a single version snapshot with its entity arrays", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ containerVersionId: "42", name: "go-live", notes: "category pixels",
      tag: [{ tagId: "10", name: "GA4" }], trigger: [], variable: [] });
  }) as unknown as typeof fetch;
  const v = await new GtmClient("tok", fetchFn).getVersion("111", "222", "42");
  expect(calls[0]).toContain("accounts/111/containers/222/versions/42");
  expect(v.containerVersionId).toBe("42");
  expect(v.notes).toBe("category pixels");
  expect(v.tag?.[0]?.tagId).toBe("10");
});

test("getLiveVersion and getLatestVersionHeader hit their special endpoints", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ containerVersionId: "42" });
  }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn);
  expect((await client.getLiveVersion("111", "222")).containerVersionId).toBe("42");
  expect((await client.getLatestVersionHeader("111", "222")).containerVersionId).toBe("42");
  expect(calls[0]).toContain("accounts/111/containers/222/versions:live");
  expect(calls[1]).toContain("accounts/111/containers/222/version_headers:latest");
});

const quota403 = '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}';
const noSleep = async () => {};

test("every request acquires the pacer first", async () => {
  let acquires = 0;
  const fetchFn = (async (url: string) =>
    url.includes("pageToken=p2") ? jsonResponse({ tag: [] }) : jsonResponse({ tag: [], nextPageToken: "p2" })) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn, { pacer: { acquire: async () => { acquires++; } }, sleep: noSleep });
  await client.listTags("accounts/1/containers/2/workspaces/3");
  expect(acquires).toBe(2);
});

test("retries a 429 then succeeds", async () => {
  const statuses = [429, 429, 200];
  let fetches = 0;
  const fetchFn = (async () => {
    const s = statuses[fetches++]!;
    return s === 200 ? jsonResponse({ tag: [{ tagId: "1" }] }) : new Response("slow down", { status: s });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const client = new GtmClient("tok", fetchFn, { sleep: async (ms) => { sleeps.push(ms); } });
  const tags = await client.listTags("accounts/1/containers/2/workspaces/3");
  expect(tags.length).toBe(1);
  expect(fetches).toBe(3);
  expect(sleeps.length).toBe(2);
});

test("honours Retry-After seconds", async () => {
  let fetches = 0;
  const fetchFn = (async () =>
    fetches++ === 0 ? new Response("", { status: 429, headers: { "Retry-After": "7" } }) : jsonResponse({ tag: [] })) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const client = new GtmClient("tok", fetchFn, { sleep: async (ms) => { sleeps.push(ms); } });
  await client.listTags("accounts/1/containers/2/workspaces/3");
  expect(sleeps).toEqual([7000]);
});

test("retries a quota 403", async () => {
  let fetches = 0;
  const fetchFn = (async () =>
    fetches++ === 0 ? new Response(quota403, { status: 403 }) : jsonResponse({ tag: [] })) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn, { sleep: noSleep });
  await client.listTags("accounts/1/containers/2/workspaces/3");
  expect(fetches).toBe(2);
});

test("gives up after 5 attempts", async () => {
  let fetches = 0;
  const fetchFn = (async () => { fetches++; return new Response("no", { status: 429 }); }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn, { sleep: noSleep });
  await expect(client.listTags("accounts/1/containers/2/workspaces/3")).rejects.toThrow(/failed \(429\)/);
  expect(fetches).toBe(5);
});

test("does not retry a permission 403", async () => {
  let fetches = 0;
  const body = '{"error":{"status":"PERMISSION_DENIED","message":"insufficient permissions"}}';
  const fetchFn = (async () => { fetches++; return new Response(body, { status: 403 }); }) as unknown as typeof fetch;
  const client = new GtmClient("tok", fetchFn, { sleep: noSleep });
  await expect(client.listTags("accounts/1/containers/2/workspaces/3")).rejects.toThrow(/403/);
  expect(fetches).toBe(1);
});

function capture(res: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return res();
  }) as unknown as typeof fetch;
  return { seen, client: new GtmClient("tok", fetchFn) };
}

test("createWorkspace POSTs the name", async () => {
  const { seen, client } = capture(() => jsonResponse({ workspaceId: "9", name: "X" }));
  const ws = await client.createWorkspace("1", "2", "X");
  expect(ws.workspaceId).toBe("9");
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url.endsWith("/accounts/1/containers/2/workspaces")).toBe(true);
  expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ name: "X" });
  expect((seen[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
});

test("createEntity POSTs to the plural path", async () => {
  const { seen, client } = capture(() => jsonResponse({ triggerId: "5" }));
  await client.createEntity("accounts/1/containers/2/workspaces/3", "trigger", { name: "T" });
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url.endsWith("/workspaces/3/triggers")).toBe(true);
  expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ name: "T" });
});

test("updateEntity PUTs with the fingerprint query", async () => {
  const { seen, client } = capture(() => jsonResponse({ tagId: "7" }));
  await client.updateEntity("accounts/1/containers/2/workspaces/3", "tag", "7", { name: "N" }, "123");
  expect(seen[0]!.init.method).toBe("PUT");
  expect(seen[0]!.url.endsWith("/tags/7?fingerprint=123")).toBe(true);
  expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ name: "N" });
});

test("deleteEntity sends DELETE and tolerates an empty 204 body", async () => {
  const { seen, client } = capture(() => new Response(null, { status: 204 }));
  await expect(client.deleteEntity("accounts/1/containers/2/workspaces/3", "folder", "4")).resolves.toBeUndefined();
  expect(seen[0]!.init.method).toBe("DELETE");
  expect(seen[0]!.url.endsWith("/workspaces/3/folders/4")).toBe(true);
});

test("the client has no publish, version or environment write path", async () => {
  const src = await Bun.file(new URL("./client.ts", import.meta.url)).text();
  expect(src).not.toMatch(/:publish|create_version|quick_preview|:set_latest|reauthorize/);
  const writes = [...src.matchAll(/request\(\s*"(POST|PUT|DELETE)"[^)]*\)/g)].map((m) => m[0]);
  for (const w of writes) expect(w).not.toMatch(/environments|versions/);
  expect(writes.length).toBe(4);
});
