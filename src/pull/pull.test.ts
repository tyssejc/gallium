import { test, expect } from "bun:test";
import { openDbAt } from "../cache/db.ts";
import { pullWorkspace, pullVersion } from "./pull.ts";
import { refsToVariable, tagFiringTriggers, unusedVariables, getMeta, pendingChanges, grepCode } from "../cache/repo.ts";

const fakeClient = {
  wsPath: () => "ws",
  listTags: async () => [{ tagId: "10", name: "GA4 Event", type: "gaawe",
    parameter: [{ type: "template", key: "measurementId", value: "{{GA4 ID}}" }],
    firingTriggerId: ["50"] }],
  listTriggers: async () => [
    { triggerId: "50", name: "All Pages", type: "pageview" },
    { triggerId: "51", name: "Consent Check", type: "customevent",
      filter: [{ type: "equals", parameter: [
        { type: "template", key: "arg0", value: "{{Consent Var}}" },
        { type: "template", key: "arg1", value: "yes" },
      ] }] },
  ],
  listVariables: async () => [
    { variableId: "v1", name: "GA4 ID", type: "c" },
    { variableId: "v2", name: "Orphan JS", type: "jsm",
      parameter: [{ type: "template", key: "javascript", value: "function(){return window.foo_bar;}" }] },
    { variableId: "v3", name: "Consent Var", type: "c" },
  ],
  listBuiltInVariables: async () => [{ type: "pageUrl", name: "Page URL" }],
  listFolders: async () => [],
  listTemplates: async () => [],
  getStatus: async () => ({ workspaceChange: [
    { changeStatus: "updated", tag: { tagId: "10", name: "GA4 Event" } },
    { changeStatus: "added", builtInVariable: { type: "pageUrl", name: "Page URL" } },
    { changeStatus: "added", customTemplate: { templateId: "t9", name: "My Template" } },
  ] }),
} as any;

test("pullContainer populates entities, refs, triggers, changes, meta", async () => {
  const db = openDbAt(":memory:");
  await pullWorkspace(db, fakeClient, "ws", "2026-06-19T00:00:00Z");
  expect(refsToVariable(db, "GA4 ID").map((r) => r.name)).toEqual(["GA4 Event"]);
  expect(tagFiringTriggers(db, "10")).toEqual([{ id: "50", name: "All Pages", relation: "firing" }]);
  expect(unusedVariables(db).map((v) => v.name)).toEqual(["Orphan JS"]);
  expect(grepCode(db, "foo_bar").map((r) => r.id)).toContain("v2");
  const changes = pendingChanges(db, {});
  expect(changes.map((c) => c.id)).toContain("10");
  expect(changes.map((c) => c.id)).toContain("pageUrl");
  expect(changes.find((c) => c.id === "pageUrl")?.kind).toBe("builtin_variable");
  expect(changes.map((c) => c.id)).toContain("t9");
  expect(changes.find((c) => c.id === "t9")?.kind).toBe("template");
  expect(getMeta(db, "last_pulled_at")).toBe("2026-06-19T00:00:00Z");
  expect(getMeta(db, "source")).toBe("workspace");

  // Trigger filter conditions: variable refs inside condition .parameter must be extracted
  const consentRefs = refsToVariable(db, "Consent Var");
  expect(consentRefs.map((r) => r.kind)).toContain("trigger");
  expect(consentRefs.map((r) => r.name)).toContain("Consent Check");
  expect(unusedVariables(db).map((v) => v.name)).not.toContain("Consent Var");
  expect(grepCode(db, "Consent Var").map((r) => r.id)).toContain("51");
});

test("pullVersion ingests a version snapshot through the same path and records version meta", async () => {
  const versionClient = {
    getVersion: async () => ({
      containerVersionId: "42", name: "go-live", notes: "category pixels",
      tag: [{ tagId: "10", name: "GA4 Event", type: "gaawe",
        parameter: [{ type: "template", key: "measurementId", value: "{{GA4 ID}}" }],
        firingTriggerId: ["50"] }],
      trigger: [{ triggerId: "50", name: "All Pages", type: "pageview" }],
      variable: [{ variableId: "v1", name: "GA4 ID", type: "c" }],
      builtInVariable: [{ type: "pageUrl", name: "Page URL" }],
      folder: [], customTemplate: [],
    }),
  } as any;
  const db = openDbAt(":memory:");
  const v = await pullVersion(db, versionClient, "111", "222", "42", "2026-07-30T00:00:00Z");
  expect(v.containerVersionId).toBe("42");
  expect(refsToVariable(db, "GA4 ID").map((r) => r.name)).toEqual(["GA4 Event"]);
  expect(tagFiringTriggers(db, "10")).toEqual([{ id: "50", name: "All Pages", relation: "firing" }]);
  expect(getMeta(db, "source")).toBe("version");
  expect(getMeta(db, "version_id")).toBe("42");
  expect(getMeta(db, "version_name")).toBe("go-live");
  expect(getMeta(db, "last_pulled_at")).toBe("2026-07-30T00:00:00Z");
  // A version has no pending changes.
  expect(pendingChanges(db, {})).toEqual([]);
});
