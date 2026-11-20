import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GtmClient } from "../gtm/client.ts";
import type { GtmWorkspace } from "../gtm/types.ts";
import type { ResolvedContainer } from "../config/config.ts";
import { resolveWorkspace, runApply } from "./apply.ts";

const BASE = "https://tagmanager.googleapis.com/tagmanager/v2/";
const CONTAINER = "accounts/1/containers/2";
const UI = "https://tagmanager.google.com/#/container/accounts/1/containers/2/workspaces";
const container: ResolvedContainer = { alias: "acme/web", accountId: "1", containerId: "2", workspaceId: "999" };

type Entity = Record<string, any>;
type Store = Record<"tag" | "trigger" | "variable" | "folder", Entity[]>;
type Fail = (method: string, path: string) => { status: number; body: string } | undefined;

const ID_FIELD = { tag: "tagId", trigger: "triggerId", variable: "variableId", folder: "folderId" } as const;
const LIST_FIELD: Record<string, string> = {
  tags: "tag", triggers: "trigger", variables: "variable", folders: "folder",
  built_in_variables: "builtInVariable", templates: "template",
};

// Base container: two tags firing on All Pages. Version 5 is the latest.
function baseStore(): Store {
  return {
    tag: [
      { tagId: "10", name: "GA4 - Purchase", type: "gaawe", firingTriggerId: ["2"], fingerprint: "f10" },
      { tagId: "11", name: "GA4 - Add To Cart", type: "gaawe", firingTriggerId: ["2"], fingerprint: "f11" },
    ],
    trigger: [{ triggerId: "2", name: "All Pages", type: "pageview", fingerprint: "f2" }],
    variable: [], folder: [],
  };
}

// A tiny in-memory GTM: lists, creates, updates and deletes against per-workspace
// stores, and records every request as "METHOD path?query".
// `ignorePuts` acknowledges updates without storing them, as a write GTM
// silently dropped would look.
function fakeGtm(opts: { workspaces?: GtmWorkspace[]; live?: string | null; fail?: Fail; ignorePuts?: boolean } = {}) {
  const requests: string[] = [];
  const bodies: Record<string, unknown> = {};
  const workspaces: GtmWorkspace[] = opts.workspaces ?? [{ workspaceId: "1", name: "Default Workspace" }];
  const stores = new Map<string, Store>(workspaces.map((w) => [w.workspaceId, baseStore()]));
  let nextId = 99;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.href.slice(BASE.length).split("?")[0]!;
    const key = `${method} ${url.href.slice(BASE.length)}`;
    requests.push(key);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body) bodies[key] = body;
    const failure = opts.fail?.(method, path);
    if (failure) return new Response(failure.body, { status: failure.status });

    if (path === `${CONTAINER}/version_headers:latest`) return json(200, { containerVersionId: "5" });
    if (path === `${CONTAINER}/versions:live`) {
      return opts.live === null ? json(404, { error: "no live version" }) : json(200, { containerVersionId: opts.live ?? "5" });
    }
    if (path === `${CONTAINER}/versions/5`) return json(200, { containerVersionId: "5", ...baseStore() });
    if (path === `${CONTAINER}/workspaces`) {
      if (method === "GET") return json(200, { workspace: workspaces });
      const ws = { workspaceId: "50", name: body.name };
      workspaces.push(ws);
      stores.set("50", baseStore());
      return json(200, ws);
    }
    const m = path.match(/^accounts\/1\/containers\/2\/workspaces\/([^/]+)\/([a-z_]+)(?:\/([^/]+))?$/);
    if (!m) return json(404, { error: `no route ${key}` });
    const [, wsId, coll, id] = m;
    const store = stores.get(wsId!);
    if (!store) return json(200, {});
    const kind = LIST_FIELD[coll!]!;
    const list: Entity[] = (store as any)[kind] ?? [];
    const idField = (ID_FIELD as any)[kind] as string;
    if (method === "GET") return json(200, { [kind]: list });
    if (method === "POST") {
      const made = { ...body, [idField]: String(nextId++), fingerprint: "new" };
      list.push(made);
      return json(200, made);
    }
    const i = list.findIndex((e) => e[idField] === id);
    if (method === "PUT" && opts.ignorePuts) return json(200, list[i]);
    if (method === "PUT") { list[i] = { ...body, fingerprint: `${body.fingerprint}+1` }; return json(200, list[i]); }
    list.splice(i, 1);
    return new Response("", { status: 200 });
  }) as typeof fetch;

  return { client: new GtmClient("tok", fetchFn), requests, bodies, writes: () => requests.filter((r) => !r.startsWith("GET ")) };
}

const SPEC = [
  { kind: "trigger", name: "Block - GPC Enabled", type: "customEvent" },
  { kind: "tag", name: "GA4 - Purchase", addBlockingTriggers: ["Block - GPC Enabled"] },
  { kind: "tag", name: "GA4 - Add To Cart", addBlockingTriggers: ["Block - GPC Enabled"] },
];

let dir: string;
let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
let specPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gallium-apply-"));
  process.env.XDG_CACHE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  specPath = join(dir, "spec.json");
  await Bun.write(specPath, JSON.stringify(SPEC));
  out = []; err = [];
  origLog = console.log; origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(...a.join(" ").split("\n")); };
  console.error = (...a: unknown[]) => { err.push(...a.join(" ").split("\n")); };
});
afterEach(() => {
  console.log = origLog; console.error = origErr;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CACHE_HOME; delete process.env.XDG_CONFIG_HOME;
});

const allowed = async () => {};
const args = (over: Partial<Parameters<typeof runApply>[0]> = {}) =>
  ({ specPath, alias: "acme/web", workspace: "Default Workspace", commit: false, json: false, ...over });

const WORKSPACES: GtmWorkspace[] = [
  { workspaceId: "1", name: "Default Workspace" },
  { workspaceId: "7", name: "Feature" },
];

test("resolveWorkspace: missing flag is an error", () => {
  const msg = "apply requires --workspace <name> or --workspace new:<Title>; it never picks a workspace for you.";
  expect(() => resolveWorkspace(undefined, WORKSPACES)).toThrow(msg);
  expect(() => resolveWorkspace("", WORKSPACES)).toThrow(msg);
});

test("resolveWorkspace: exact name; unknown name lists the real ones; duplicate name is an error", () => {
  expect(resolveWorkspace("Feature", WORKSPACES)).toEqual({ mode: "existing", workspaceId: "7", name: "Feature" });
  let msg = "";
  try { resolveWorkspace("default workspace", WORKSPACES); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain('No workspace named "default workspace"');
  expect(msg).toContain("Default Workspace (1)");
  expect(msg).toContain("Feature (7)");
  const dup = [...WORKSPACES, { workspaceId: "8", name: "Feature" }];
  expect(() => resolveWorkspace("Feature", dup)).toThrow(/2 workspaces are named "Feature"[\s\S]*Feature \(7\)[\s\S]*Feature \(8\)/);
});

test("resolveWorkspace: new:Title is new, or existing when already created", () => {
  expect(resolveWorkspace("new:GPC signal", WORKSPACES)).toEqual({ mode: "new", name: "GPC signal" });
  expect(resolveWorkspace("new:Feature", WORKSPACES)).toEqual({ mode: "existing", workspaceId: "7", name: "Feature" });
});

test("an @snapshot ref is rejected", async () => {
  const gtm = fakeGtm();
  await expect(runApply(args({ alias: "acme/web@live" }), { client: gtm.client, container, assertWriteAllowed: allowed }))
    .rejects.toThrow("'acme/web@live' is a snapshot ref");
  expect(gtm.requests).toEqual([]);
});

test("dry run sends only GET requests and does not check write scope", async () => {
  const gtm = fakeGtm();
  let gateCalls = 0;
  const code = await runApply(args(), { client: gtm.client, container,
    assertWriteAllowed: async () => { gateCalls++; throw new Error("no write scope"); } });
  expect(code).toBe(0);
  expect(gateCalls).toBe(0);
  expect(gtm.requests.length).toBeGreaterThan(0);
  expect(gtm.writes()).toEqual([]);
  expect(out).toEqual([
    'Target: acme/web — workspace "Default Workspace" (1)',
    "DRY RUN — nothing sent. Re-run with --commit to apply.",
    'CREATE trigger "Block - GPC Enabled"',
    'UPDATE tag "GA4 - Purchase" (blockingTriggerId)',
    'UPDATE tag "GA4 - Add To Cart" (blockingTriggerId)',
    `${UI}/1`,
  ]);
});

test("dry run with new:Title plans against the latest version and creates nothing", async () => {
  const gtm = fakeGtm();
  const code = await runApply(args({ workspace: "new:GPC signal" }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(0);
  expect(gtm.requests).toEqual([
    `GET ${CONTAINER}/workspaces`,
    `GET ${CONTAINER}/version_headers:latest`,
    `GET ${CONTAINER}/versions:live`,
    `GET ${CONTAINER}/versions/5`,
  ]);
  expect(out).toContain('CREATE trigger "Block - GPC Enabled"');
  expect(out).toContain('UPDATE tag "GA4 - Purchase" (blockingTriggerId)');
});

test("commit refuses without write scope and sends nothing", async () => {
  const gtm = fakeGtm();
  const deny = async () => { throw new Error("This login is read-only. Run: gallium login --write"); };
  await expect(runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: deny }))
    .rejects.toThrow("This login is read-only. Run: gallium login --write");
  expect(gtm.requests).toEqual([]);
});

test("commit with new:Title creates the workspace, applies, and verifies", async () => {
  const gtm = fakeGtm();
  const code = await runApply(args({ workspace: "new:GPC signal", commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(0);
  expect(gtm.writes()).toEqual([
    `POST ${CONTAINER}/workspaces`,
    `POST ${CONTAINER}/workspaces/50/triggers`,
    `PUT ${CONTAINER}/workspaces/50/tags/10?fingerprint=f10`,
    `PUT ${CONTAINER}/workspaces/50/tags/11?fingerprint=f11`,
  ]);
  expect(gtm.bodies[`POST ${CONTAINER}/workspaces`]).toEqual({ name: "GPC signal" });
  expect((gtm.bodies[`PUT ${CONTAINER}/workspaces/50/tags/10?fingerprint=f10`] as any).blockingTriggerId).toEqual(["99"]);
  // Verification re-lists the workspace after the writes.
  expect(gtm.requests.at(-1)).toBe(`GET ${CONTAINER}/workspaces/50/templates`);
  expect(out).toEqual([
    'Target: acme/web — workspace "GPC signal" (50)',
    'APPLIED to workspace "GPC signal" (50)',
    'CREATE trigger "Block - GPC Enabled"',
    'UPDATE tag "GA4 - Purchase" (blockingTriggerId)',
    'UPDATE tag "GA4 - Add To Cart" (blockingTriggerId)',
    `${UI}/50`,
    "Not published. Preview and publish in the GTM UI.",
  ]);
});

test("commit never uses the alias's pinned workspace_id", async () => {
  const gtm = fakeGtm();
  expect(container.workspaceId).toBe("999");
  const code = await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(0);
  expect(gtm.requests.filter((r) => r.includes("999"))).toEqual([]);
  expect(gtm.writes().every((r) => r.includes("/workspaces/1/"))).toBe(true);
});

test("a mid-apply 409 reports applied and not-applied and exits 1", async () => {
  const body = '{"error":{"code":409,"message":"Fingerprint mismatch"}}';
  const gtm = fakeGtm({ fail: (method, path) => (method === "PUT" && path.endsWith("/tags/10") ? { status: 409, body } : undefined) });
  const code = await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(1);
  expect(gtm.writes()).toEqual([
    `POST ${CONTAINER}/workspaces/1/triggers`,
    `PUT ${CONTAINER}/workspaces/1/tags/10?fingerprint=f10`,
  ]);
  expect(out).toEqual([
    'Target: acme/web — workspace "Default Workspace" (1)',
    'CREATE trigger "Block - GPC Enabled"',
    `FAILED UPDATE tag "GA4 - Purchase" (blockingTriggerId): GTM PUT ${CONTAINER}/workspaces/1/tags/10 failed (409): ${body}`,
    'NOT APPLIED UPDATE tag "GA4 - Add To Cart" (blockingTriggerId)',
    "The entity changed since it was read; re-run to plan against the current state.",
    `${UI}/1`,
    "Not published. Preview and publish in the GTM UI.",
  ]);
});

test("a permission 403 on write prints the login --write hint and exits 1", async () => {
  const body = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}';
  const gtm = fakeGtm({ fail: (method) => (method === "POST" ? { status: 403, body } : undefined) });
  const code = await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(1);
  expect(gtm.writes()).toEqual([`POST ${CONTAINER}/workspaces/1/triggers`]);
  expect(out).toContain("If write access was revoked, run: gallium login --write");
  expect(out).not.toContain("The entity changed since it was read; re-run to plan against the current state.");
  expect(out).toContain('NOT APPLIED UPDATE tag "GA4 - Purchase" (blockingTriggerId)');
});

test("a second commit of the same spec is all UNCHANGED and sends no writes", async () => {
  const gtm = fakeGtm();
  expect(await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed })).toBe(0);
  const before = gtm.writes().length;
  out.length = 0;
  expect(await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed })).toBe(0);
  expect(gtm.writes().length).toBe(before);
  expect(out).toEqual([
    'Target: acme/web — workspace "Default Workspace" (1)',
    'APPLIED to workspace "Default Workspace" (1)',
    'UNCHANGED trigger "Block - GPC Enabled"',
    'UNCHANGED tag "GA4 - Purchase"',
    'UNCHANGED tag "GA4 - Add To Cart"',
    `${UI}/1`,
    "Not published. Preview and publish in the GTM UI.",
  ]);
});

test("a write that does not show up on re-read is reported NOT VERIFIED and exits 1", async () => {
  const gtm = fakeGtm({ ignorePuts: true });
  const code = await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(1);
  expect(out).toEqual([
    'Target: acme/web — workspace "Default Workspace" (1)',
    'APPLIED to workspace "Default Workspace" (1)',
    'CREATE trigger "Block - GPC Enabled"',
    'UPDATE tag "GA4 - Purchase" (blockingTriggerId)',
    'UPDATE tag "GA4 - Add To Cart" (blockingTriggerId)',
    'NOT VERIFIED UPDATE tag "GA4 - Purchase" (blockingTriggerId)',
    'NOT VERIFIED UPDATE tag "GA4 - Add To Cart" (blockingTriggerId)',
    `${UI}/1`,
    "Not published. Preview and publish in the GTM UI.",
  ]);
});

test("a failed verification read still reports the applied writes and the workspace, and exits 1", async () => {
  // The second listing of the workspace's tags is the verification read.
  const failVerify = (): Fail => {
    let tagReads = 0;
    return (method, path) => (method === "GET" && path.endsWith("/workspaces/1/tags") && ++tagReads === 2
      ? { status: 500, body: "down" } : undefined);
  };
  const gtm = fakeGtm({ fail: failVerify() });
  const code = await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(1);
  expect(gtm.writes().length).toBe(3);
  expect(out).toEqual([
    'Target: acme/web — workspace "Default Workspace" (1)',
    'APPLIED to workspace "Default Workspace" (1)',
    'CREATE trigger "Block - GPC Enabled"',
    'UPDATE tag "GA4 - Purchase" (blockingTriggerId)',
    'UPDATE tag "GA4 - Add To Cart" (blockingTriggerId)',
    `VERIFY FAILED: GTM GET ${CONTAINER}/workspaces/1/tags failed (500): down`,
    `${UI}/1`,
    "Not published. Preview and publish in the GTM UI.",
  ]);

  out.length = 0;
  const json = fakeGtm({ fail: failVerify() });
  expect(await runApply(args({ commit: true, json: true }), { client: json.client, container, assertWriteAllowed: allowed })).toBe(1);
  const res = JSON.parse(out.join("\n"));
  expect(res.workspace).toEqual({ name: "Default Workspace", id: "1", url: `${UI}/1` });
  expect(res.container).toBe("acme/web");
  expect(res.error).toBe(`GTM GET ${CONTAINER}/workspaces/1/tags failed (500): down`);
});

test("a new:Title commit whose first read fails still prints the created workspace, and exits 1", async () => {
  const gtm = fakeGtm({ fail: (method, path) => (method === "GET" && path.endsWith("/workspaces/50/tags") ? { status: 500, body: "down" } : undefined) });
  const code = await runApply(args({ workspace: "new:GPC signal", commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed });
  expect(code).toBe(1);
  expect(gtm.writes()).toEqual([`POST ${CONTAINER}/workspaces`]);
  expect(out).toEqual([
    'Target: acme/web — workspace "GPC signal" (50)',
    'CREATED workspace "GPC signal" (50); no entity writes were sent.',
    `FAILED: GTM GET ${CONTAINER}/workspaces/50/tags failed (500): down`,
    `${UI}/50`,
    "Not published. Preview and publish in the GTM UI.",
  ]);
});

test("warns when latest is not live", async () => {
  const warning = "warning: latest version v5 is not live (live is v4); a new workspace starts from v5.";
  const stale = fakeGtm({ live: "4" });
  expect(await runApply(args({ workspace: "new:GPC signal" }), { client: stale.client, container, assertWriteAllowed: allowed })).toBe(0);
  expect(err).toEqual([warning]);

  err.length = 0;
  const current = fakeGtm({ live: "5" });
  expect(await runApply(args({ workspace: "new:GPC signal" }), { client: current.client, container, assertWriteAllowed: allowed })).toBe(0);
  expect(err).toEqual([]);

  // No published version: the live lookup fails and is ignored.
  const unpublished = fakeGtm({ live: null });
  expect(await runApply(args({ workspace: "new:GPC signal" }), { client: unpublished.client, container, assertWriteAllowed: allowed })).toBe(0);
  expect(err).toEqual([]);
});

test("a plan or spec error prints one line per problem, exits 1 and sends no write", async () => {
  await Bun.write(specPath, JSON.stringify([
    { kind: "tag", name: "GA4 - Purchase", addBlockingTriggers: ["Nope"] },
    { kind: "tag", name: "GA4 - Add To Cart", addBlockingTriggers: ["Also Nope"] },
  ]));
  const gtm = fakeGtm();
  expect(await runApply(args({ commit: true }), { client: gtm.client, container, assertWriteAllowed: allowed })).toBe(1);
  expect(err).toEqual([
    'tag "GA4 - Purchase": trigger "Nope" not found',
    'tag "GA4 - Add To Cart": trigger "Also Nope" not found',
  ]);
  expect(gtm.writes()).toEqual([]);

  err.length = 0;
  await Bun.write(specPath, JSON.stringify([{ kind: "tag" }, { kind: "widget", name: "W" }]));
  const untouched = fakeGtm();
  expect(await runApply(args({ commit: true }), { client: untouched.client, container, assertWriteAllowed: allowed })).toBe(1);
  expect(err).toEqual([
    `spec ${specPath} is invalid:`,
    "entry 0: name is required",
    'entry 1: kind must be one of tag, trigger, variable, folder (got "widget")',
  ]);
  expect(untouched.requests).toEqual([]);
});

test("--json prints the workspace, the ops with full request bodies, and failures", async () => {
  const gtm = fakeGtm({ fail: (method, path) => (method === "PUT" && path.endsWith("/tags/10") ? { status: 412, body: "stale" } : undefined) });
  expect(await runApply(args({ commit: true, json: true }), { client: gtm.client, container, assertWriteAllowed: allowed })).toBe(1);
  const res = JSON.parse(out.join("\n"));
  expect(res.workspace).toEqual({ name: "Default Workspace", id: "1", url: `${UI}/1` });
  expect(res.container).toBe("acme/web");
  expect(res.committed).toBe(true);
  expect(res.ops.map((o: any) => o.action)).toEqual(["create", "update", "update"]);
  expect(res.ops[0].body).toEqual({ name: "Block - GPC Enabled", type: "customEvent" });
  expect(res.ops[1].body.blockingTriggerId).toEqual(["@new:trigger:block - gpc enabled"]);
  expect(res.failed.op.name).toBe("GA4 - Purchase");
  expect(res.failed.error).toContain("(412): stale");
  expect(res.pending.map((o: any) => o.name)).toEqual(["GA4 - Add To Cart"]);
  expect(res.unverified).toBeUndefined();
});

test("the Target line names the alias and workspace: existing, and new before creation", async () => {
  const gtm = fakeGtm();
  expect(await runApply(args({ workspace: "new:GPC signal" }), { client: gtm.client, container, assertWriteAllowed: allowed })).toBe(0);
  expect(out[0]).toBe('Target: acme/web — workspace "GPC signal" (will be created)');
  expect(out[1]).toBe("DRY RUN — nothing sent. Re-run with --commit to apply.");

  out.length = 0;
  expect(await runApply(args({ workspace: "new:GPC signal", json: true }), { client: fakeGtm().client, container, assertWriteAllowed: allowed })).toBe(0);
  const res = JSON.parse(out.join("\n"));
  expect(res.container).toBe("acme/web");
  expect(res.workspace).toEqual({ name: "GPC signal", id: null });

  out.length = 0;
  expect(await runApply(args({ workspace: "Default Workspace" }), { client: fakeGtm().client, container, assertWriteAllowed: allowed })).toBe(0);
  expect(out[0]).toBe('Target: acme/web — workspace "Default Workspace" (1)');

  out.length = 0;
  expect(await runApply(args({ json: true }), { client: fakeGtm().client, container, assertWriteAllowed: allowed })).toBe(0);
  const existing = JSON.parse(out.join("\n"));
  expect(existing.container).toBe("acme/web");
  expect(existing.workspace).toEqual({ name: "Default Workspace", id: "1", url: `${UI}/1` });
});

test("a commit prints each op to stderr as it lands, and stdout stays the report", async () => {
  const body = '{"error":{"code":409,"message":"Fingerprint mismatch"}}';
  const fail: Fail = (method, path) => (method === "PUT" && path.endsWith("/tags/11") ? { status: 409, body } : undefined);
  const progress = [
    'CREATE trigger "Block - GPC Enabled"',
    'UPDATE tag "GA4 - Purchase" (blockingTriggerId)',
    `FAILED UPDATE tag "GA4 - Add To Cart" (blockingTriggerId): GTM PUT ${CONTAINER}/workspaces/1/tags/11 failed (409): ${body}`,
  ];
  expect(await runApply(args({ commit: true }), { client: fakeGtm({ fail }).client, container, assertWriteAllowed: allowed })).toBe(1);
  expect(err).toEqual(progress);

  out.length = 0; err.length = 0;
  expect(await runApply(args({ commit: true, json: true }), { client: fakeGtm({ fail }).client, container, assertWriteAllowed: allowed })).toBe(1);
  expect(err).toEqual(progress);
  const res = JSON.parse(out.join("\n"));
  expect(res.ops.map((o: any) => o.action)).toEqual(["create", "update", "update"]);
  expect(res.failed.op.name).toBe("GA4 - Add To Cart");
});
