import { test, expect } from "bun:test";
import type { GtmClient } from "../gtm/client.ts";
import { executePlan } from "./execute.ts";
import { newRef, type Op } from "./plan.ts";

const WS = "accounts/1/containers/2/workspaces/3";

type Call = { method: string; kind: string; id?: string; body?: unknown; fingerprint?: string };

// Records every write; creates return ids from `ids` in order. `failAt` makes
// the nth write (1-based) throw.
function recorder(opts: { ids?: string[]; failAt?: number } = {}) {
  const calls: Call[] = [];
  const ids = [...(opts.ids ?? [])];
  const idField: Record<string, string> = { tag: "tagId", trigger: "triggerId", variable: "variableId", folder: "folderId" };
  const step = (c: Call) => {
    calls.push(c);
    if (calls.length === opts.failAt) throw new Error("GTM PUT x failed (409): boom");
  };
  const client = {
    createEntity: async (ws: string, kind: string, body: object) => {
      expect(ws).toBe(WS);
      step({ method: "POST", kind, body: structuredClone(body) });
      return { ...body, [idField[kind]!]: ids.shift() };
    },
    updateEntity: async (ws: string, kind: string, id: string, body: object, fingerprint?: string) => {
      expect(ws).toBe(WS);
      step({ method: "PUT", kind, id, body: structuredClone(body), fingerprint });
      return body;
    },
    deleteEntity: async (ws: string, kind: string, id: string) => {
      expect(ws).toBe(WS);
      step({ method: "DELETE", kind, id });
    },
  } as unknown as GtmClient;
  return { client, calls };
}

const createTrigger: Op = { action: "create", kind: "trigger", name: "Block - GPC Enabled", body: { name: "Block - GPC Enabled", type: "customEvent" } };
const updateTag: Op = { action: "update", kind: "tag", name: "GA4 - Purchase", id: "10", fingerprint: "f10",
  body: { tagId: "10", name: "GA4 - Purchase", blockingTriggerId: [newRef("trigger", "Block - GPC Enabled")] }, changed: ["blockingTriggerId"] };
const unchangedTag: Op = { action: "unchanged", kind: "tag", name: "Y", id: "12" };
const deleteVar: Op = { action: "delete", kind: "variable", name: "X", id: "30", fingerprint: "f30" };

test("sends creates, updates and deletes in plan order and skips unchanged", async () => {
  const { client, calls } = recorder({ ids: ["99"] });
  const res = await executePlan([createTrigger, updateTag, unchangedTag, deleteVar], client, WS);
  expect(calls.map((c) => [c.method, c.kind, c.id])).toEqual([
    ["POST", "trigger", undefined],
    ["PUT", "tag", "10"],
    ["DELETE", "variable", "30"],
  ]);
  expect(res.applied.map((o) => `${o.action} ${o.name}`)).toEqual(["create Block - GPC Enabled", "update GA4 - Purchase", "delete X"]);
  expect(res.failed).toBeUndefined();
  expect(res.pending).toEqual([]);
});

test("substitutes the created id for a placeholder in a later body", async () => {
  const { client, calls } = recorder({ ids: ["99"] });
  const nested: Op = { action: "create", kind: "tag", name: "Uses Trigger",
    body: { name: "Uses Trigger", type: "html", firingTriggerId: [newRef("trigger", "Block - GPC Enabled")],
      parameter: [{ type: "list", key: "l", list: [{ type: "triggerReference", key: "t", value: newRef("trigger", "Block - GPC Enabled") }] }] } };
  await executePlan([createTrigger, updateTag, nested], client, WS);
  expect((calls[1]!.body as any).blockingTriggerId).toEqual(["99"]);
  expect((calls[2]!.body as any).firingTriggerId).toEqual(["99"]);
  expect((calls[2]!.body as any).parameter[0].list[0].value).toBe("99");
  // The plan itself is left untouched.
  expect(updateTag.body!.blockingTriggerId).toEqual([newRef("trigger", "Block - GPC Enabled")]);
});

test("passes the fingerprint on update", async () => {
  const { client, calls } = recorder();
  const plain: Op = { ...updateTag, body: { tagId: "10", name: "GA4 - Purchase", blockingTriggerId: ["5"] } };
  await executePlan([plain], client, WS);
  expect(calls).toEqual([{ method: "PUT", kind: "tag", id: "10", body: plain.body, fingerprint: "f10" }]);
});

test("stops at the first failure and reports applied, failed and pending", async () => {
  const { client, calls } = recorder({ ids: ["99"], failAt: 2 });
  const res = await executePlan([createTrigger, updateTag, unchangedTag, deleteVar], client, WS);
  expect(calls.length).toBe(2);
  expect(res.applied.map((o) => o.name)).toEqual(["Block - GPC Enabled"]);
  expect(res.failed?.op.name).toBe("GA4 - Purchase");
  expect(res.failed?.error).toBe("GTM PUT x failed (409): boom");
  expect(res.pending.map((o) => o.name)).toEqual(["X"]);
});

test("a create response without an id fails that op and sends nothing that depends on it", async () => {
  const { client, calls } = recorder({ ids: [] });
  const res = await executePlan([createTrigger, updateTag], client, WS);
  expect(calls.map((c) => c.method)).toEqual(["POST"]);
  expect(res.applied).toEqual([]);
  expect(res.failed?.op.name).toBe("Block - GPC Enabled");
  expect(res.failed?.error).toBe('create trigger "Block - GPC Enabled" returned no triggerId');
  expect(res.pending.map((o) => o.name)).toEqual(["GA4 - Purchase"]);
});
