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
