import { test, expect } from "bun:test";
import { buildPlan, newRef, PlanError, type Op } from "./plan.ts";
import type { SpecEntry } from "./spec.ts";
import type { EntitySnapshot } from "../pull/pull.ts";

// Raw API objects carry fields the TS types don't declare; the planner must keep them.
const RAW = { accountId: "6", containerId: "7", workspaceId: "8" };

function fixture(): EntitySnapshot {
  return {
    tag: [
      { ...RAW, tagId: "10", name: "GA4 - Purchase", type: "gaawe", firingTriggerId: ["3"], fingerprint: "111",
        tagManagerUrl: "https://tagmanager.google.com/#/x", parameter: [{ type: "template", key: "eventName", value: "purchase" }] },
      { ...RAW, tagId: "11", name: "Ads - Linker", type: "gclidw", firingTriggerId: ["3"], fingerprint: "112" },
    ] as EntitySnapshot["tag"],
    trigger: [{ ...RAW, triggerId: "3", name: "All Pages", type: "pageview", fingerprint: "113" }] as EntitySnapshot["trigger"],
    variable: [{ ...RAW, variableId: "5", name: "JS - GPC Enabled", type: "jsm", fingerprint: "115",
      parameter: [{ type: "template", key: "javascript", value: "function(){ return navigator.globalPrivacyControl === true; }" }] }] as EntitySnapshot["variable"],
    folder: [{ ...RAW, folderId: "2", name: "Google", fingerprint: "112" }] as EntitySnapshot["folder"],
    builtInVariable: [{ type: "PAGE_URL", name: "Page URL" }],
  };
}

const storedTag = (id: string) => fixture().tag!.find((t) => t.tagId === id)!;

const GPC_TRIGGER: SpecEntry = {
  kind: "trigger", name: "Block - GPC Enabled", type: "customEvent",
  customEventFilter: [{ type: "equals", parameter: [
    { type: "template", key: "arg0", value: "{{_event}}" }, { type: "template", key: "arg1", value: ".*" }] }],
  filter: [{ type: "equals", parameter: [
    { type: "template", key: "arg0", value: "{{JS - GPC Enabled}}" }, { type: "template", key: "arg1", value: "true" }] }],
};

function problems(entries: SpecEntry[], snap = fixture()): string[] {
  try { buildPlan(entries, snap); } catch (e) {
    expect(e).toBeInstanceOf(PlanError);
    return (e as PlanError).problems;
  }
  throw new Error("expected buildPlan to throw");
}

const summary = (ops: Op[]) => ops.map((o) => `${o.action} ${o.kind} ${o.name}`);

test("creates a trigger that does not exist", () => {
  const { kind: _k, name, ...fields } = GPC_TRIGGER;
  expect(buildPlan([GPC_TRIGGER], fixture())).toEqual([
    { action: "create", kind: "trigger", name: "Block - GPC Enabled", body: { name, ...fields } },
  ]);
  const [op] = buildPlan([{ kind: "tag", name: "New", type: "html", folder: "Google", firingTriggers: ["All Pages"] }], fixture());
  expect(op!.body).toEqual({ name: "New", type: "html", parentFolderId: "2", firingTriggerId: ["3"] });
});

test("create without type is an error (folders excepted)", () => {
  expect(problems([{ kind: "tag", name: "New Tag" }])).toEqual(['tag "New Tag": create requires type']);
  expect(buildPlan([{ kind: "folder", name: "Consent" }], fixture())).toEqual([
    { action: "create", kind: "folder", name: "Consent", body: { name: "Consent" } },
  ]);
});

test("patch replaces only the given top-level fields", () => {
  expect(buildPlan([{ kind: "tag", name: "GA4 - Purchase", paused: true }], fixture())).toEqual([{
    action: "update", kind: "tag", name: "GA4 - Purchase", id: "10", fingerprint: "111",
    body: { ...storedTag("10"), paused: true }, changed: ["paused"],
  }]);
});

test("addBlockingTriggers appends by name and is a no-op when present", () => {
  const entry: SpecEntry = { kind: "tag", name: "Ads - Linker", addBlockingTriggers: ["All Pages"] };
  const [op] = buildPlan([entry], fixture());
  expect(op!.action).toBe("update");
  expect(op!.body!.blockingTriggerId).toEqual(["3"]);
  expect(op!.changed).toEqual(["blockingTriggerId"]);

  const already = fixture();
  already.tag![1]!.blockingTriggerId = ["3"];
  expect(buildPlan([entry], already)).toEqual([{ action: "unchanged", kind: "tag", name: "Ads - Linker", id: "11" }]);
});

test("blockingTriggers sets the whole list; removeFiringTriggers removes", () => {
  const snap = fixture();
  snap.tag![0]!.blockingTriggerId = ["3", "99"];
  const [op] = buildPlan([{ kind: "tag", name: "GA4 - Purchase", blockingTriggers: ["All Pages"], removeFiringTriggers: ["All Pages"] }], snap);
  expect(op!.body!.blockingTriggerId).toEqual(["3"]);
  expect(op!.body!.firingTriggerId).toEqual([]);
  expect(op!.changed).toEqual(["blockingTriggerId", "firingTriggerId"]);
});

test("a trigger created in the same spec is referenced by placeholder", () => {
  const ops = buildPlan([GPC_TRIGGER, { kind: "tag", name: "GA4 - Purchase", addBlockingTriggers: ["Block - GPC Enabled"] }], fixture());
  expect(newRef("trigger", "Block - GPC Enabled")).toBe("@new:trigger:block - gpc enabled");
  expect(ops[1]!.body!.blockingTriggerId).toEqual(["@new:trigger:block - gpc enabled"]);
});

test("folder resolves to parentFolderId", () => {
  const [op] = buildPlan([{ kind: "tag", name: "GA4 - Purchase", folder: "google" }], fixture());
  expect(op!.body!.parentFolderId).toBe("2");
  expect(op!.changed).toEqual(["parentFolderId"]);
  expect(op!.body).not.toHaveProperty("folder");

  const ops = buildPlan([{ kind: "folder", name: "Consent" }, { kind: "variable", name: "Const", type: "c", folder: "Consent" }], fixture());
  expect(ops[1]!.body!.parentFolderId).toBe("@new:folder:consent");
});

test("rename updates the name; re-planning after the rename is unchanged", () => {
  const entry: SpecEntry = { kind: "trigger", name: "All Pages", rename: "Every Page" };
  const [op] = buildPlan([entry], fixture());
  expect(op).toMatchObject({ action: "update", id: "3", fingerprint: "113", changed: ["name"] });
  expect(op!.body!.name).toBe("Every Page");
  expect(op!.body).not.toHaveProperty("rename");

  const after = fixture();
  after.trigger![0]!.name = "Every Page";
  expect(buildPlan([entry], after)).toEqual([{ action: "unchanged", kind: "trigger", name: "Every Page", id: "3" }]);
});

test("an identical patch is unchanged", () => {
  expect(buildPlan([{ kind: "tag", name: "GA4 - Purchase", type: "gaawe", firingTriggers: ["All Pages"] }], fixture()))
    .toEqual([{ action: "unchanged", kind: "tag", name: "GA4 - Purchase", id: "10" }]);
});

test("name matching ignores case and surrounding space", () => {
  const [op] = buildPlan([{ kind: "tag", name: "  ga4 - PURCHASE ", addBlockingTriggers: [" all pages  "] }], fixture());
  expect(op).toMatchObject({ action: "update", id: "10", name: "GA4 - Purchase" });
  expect(op!.body!.blockingTriggerId).toEqual(["3"]);
});

test("two entities with the same name is an error naming both ids", () => {
  const snap = fixture();
  snap.tag!.push({ tagId: "12", name: "ga4 - purchase", type: "gaawe" });
  expect(problems([{ kind: "tag", name: "GA4 - Purchase", paused: true }], snap))
    .toEqual(['tag "GA4 - Purchase" matches 2 tags (ids 10, 12)']);
});

test("an unresolved trigger, folder or {{variable}} is an error", () => {
  expect(problems([{
    kind: "tag", name: "GA4 - Purchase", addFiringTriggers: ["Nope"], folder: "Nowhere",
    parameter: [{ type: "template", key: "eventName", value: "{{Missing Var}}" }],
  }])).toEqual([
    'tag "GA4 - Purchase": folder "Nowhere" not found',
    'tag "GA4 - Purchase": trigger "Nope" not found',
    'tag "GA4 - Purchase": {{Missing Var}} is not a variable or enabled built-in',
  ]);
});

test("{{_event}} and enabled built-ins resolve", () => {
  const entries: SpecEntry[] = [
    { kind: "variable", name: "New Var", type: "c", parameter: [{ type: "template", key: "value", value: "x" }] },
    { kind: "tag", name: "HTML", type: "html", parameter: [{ type: "template", key: "html",
      value: "{{_event}} {{Page URL}} {{JS - GPC Enabled}} {{New Var}}" }] },
  ];
  expect(summary(buildPlan(entries, fixture()))).toEqual(["create variable New Var", "create tag HTML"]);
  // A built-in the workspace has not enabled does not resolve.
  expect(problems([{ kind: "tag", name: "GA4 - Purchase",
    parameter: [{ type: "template", key: "eventName", value: "{{Page Path}}" }] }]))
    .toEqual(['tag "GA4 - Purchase": {{Page Path}} is not a variable or enabled built-in']);
});

test("deleting a trigger still used by a tag is refused", () => {
  expect(problems([{ kind: "trigger", name: "All Pages", delete: true }])).toEqual([
    'cannot delete trigger "All Pages": still used by tag "GA4 - Purchase" (10)',
    'cannot delete trigger "All Pages": still used by tag "Ads - Linker" (11)',
  ]);
  expect(problems([{ kind: "variable", name: "JS - GPC Enabled", delete: true }, GPC_TRIGGER])).toEqual([
    'trigger "Block - GPC Enabled": {{JS - GPC Enabled}} is not a variable or enabled built-in',
    'cannot delete variable "JS - GPC Enabled": still used by trigger "Block - GPC Enabled" (@new:trigger:block - gpc enabled)',
  ]);
  const inFolder = fixture();
  inFolder.variable![0]!.parentFolderId = "2";
  expect(problems([{ kind: "folder", name: "Google", delete: true }], inFolder))
    .toEqual(['cannot delete folder "Google": still used by variable "JS - GPC Enabled" (5)']);
});

test("deleting a trigger is allowed when the same spec removes it from every tag", () => {
  const ops = buildPlan([
    { kind: "trigger", name: "All Pages", delete: true },
    { kind: "tag", name: "GA4 - Purchase", removeFiringTriggers: ["All Pages"] },
    { kind: "tag", name: "Ads - Linker", delete: true },   // a deleted tag no longer counts as a user
  ], fixture());
  expect(ops).toEqual([
    { action: "update", kind: "tag", name: "GA4 - Purchase", id: "10", fingerprint: "111",
      body: { ...storedTag("10"), firingTriggerId: [] }, changed: ["firingTriggerId"] },
    { action: "delete", kind: "tag", name: "Ads - Linker", id: "11", fingerprint: "112" },
    { action: "delete", kind: "trigger", name: "All Pages", id: "3", fingerprint: "113" },
  ]);
});

test("deleting an absent entity is unchanged", () => {
  expect(buildPlan([{ kind: "tag", name: "Gone", delete: true }], fixture()))
    .toEqual([{ action: "unchanged", kind: "tag", name: "Gone" }]);
});

test("orders creates folder→variable→trigger→tag, then deletes in reverse", () => {
  const ops = buildPlan([
    { kind: "tag", name: "GA4 - Purchase", type: "gaawe" },          // unchanged
    { kind: "tag", name: "New Tag", type: "html", firingTriggers: ["New Trigger"] },
    { kind: "tag", name: "Ads - Linker", delete: true },
    { kind: "trigger", name: "New Trigger", type: "pageview" },
    { kind: "folder", name: "Google", delete: true },
    { kind: "variable", name: "New Var", type: "c" },
    { kind: "trigger", name: "All Pages", notes: "every page" },     // update
    { kind: "folder", name: "New Folder" },
    { kind: "variable", name: "JS - GPC Enabled", delete: true },
  ], fixture());
  expect(summary(ops)).toEqual([
    "create folder New Folder",
    "create variable New Var",
    "create trigger New Trigger",
    "update trigger All Pages",
    "create tag New Tag",
    "delete tag Ads - Linker",
    "delete variable JS - GPC Enabled",
    "delete folder Google",
    "unchanged tag GA4 - Purchase",
  ]);
});

test("collects every problem into one PlanError", () => {
  const found = problems([{ kind: "tag", name: "X" }, { kind: "tag", name: "GA4 - Purchase", folder: "Nowhere" }]);
  expect(found.length).toBe(2);
  expect(found).toEqual(['tag "X": create requires type', 'tag "GA4 - Purchase": folder "Nowhere" not found']);
});

test("the bulk shape: one trigger plus N tag patches", () => {
  const ops = buildPlan([
    GPC_TRIGGER,
    { kind: "tag", name: "GA4 - Purchase", addBlockingTriggers: ["Block - GPC Enabled"] },
    { kind: "tag", name: "Ads - Linker", addBlockingTriggers: ["Block - GPC Enabled"] },
  ], fixture());
  expect(summary(ops)).toEqual(["create trigger Block - GPC Enabled", "update tag GA4 - Purchase", "update tag Ads - Linker"]);
  for (const op of ops.slice(1)) {
    expect(op.changed).toEqual(["blockingTriggerId"]);
    expect(op.body!.blockingTriggerId).toEqual([newRef("trigger", "Block - GPC Enabled")]);
  }
  expect(ops[1]!.body).toEqual({ ...storedTag("10"), blockingTriggerId: ["@new:trigger:block - gpc enabled"] });
});

test("a rename onto an existing entity's name is an error naming both ids", () => {
  expect(problems([{ kind: "tag", name: "Ads - Linker", rename: "ga4 - purchase" }]))
    .toEqual(['2 tags would be named "ga4 - purchase" (ids 10, 11)']);
});

test("a rename onto a created entity's name is an error naming both ids", () => {
  expect(problems([{ kind: "tag", name: "New", type: "html" }, { kind: "tag", name: "Ads - Linker", rename: "New" }]))
    .toEqual(['2 tags would be named "New" (ids 11, @new:tag:new)']);
});

test("a delete and a rename-target patch cannot claim the same entity", () => {
  expect(problems([
    { kind: "tag", name: "GA4 - Purchase", delete: true },
    { kind: "tag", name: "X", rename: "GA4 - Purchase", paused: true },
  ])).toEqual(['tag "X": refers to the same tag (10) as tag "GA4 - Purchase"']);
});

test("two renames cannot claim the same entity", () => {
  expect(problems([
    { kind: "tag", name: "GA4 - Purchase", rename: "B" },
    { kind: "tag", name: "C", rename: "GA4 - Purchase" },
  ])).toEqual(['tag "C": refers to the same tag (10) as tag "GA4 - Purchase"']);
});

test("deleting a tag used as another tag's setup tag, or by a tagReference parameter, is refused", () => {
  const setup = fixture();
  (setup.tag![1] as unknown as Record<string, unknown>).setupTag = [{ tagName: "GA4 - Purchase" }];
  expect(problems([{ kind: "tag", name: "GA4 - Purchase", delete: true }], setup))
    .toEqual(['cannot delete tag "GA4 - Purchase": still used by tag "Ads - Linker" (11)']);

  const param = fixture();
  param.tag![1]!.parameter = [{ type: "tagReference", key: "tag", value: "GA4 - Purchase" }];
  expect(problems([{ kind: "tag", name: "GA4 - Purchase", delete: true }], param))
    .toEqual(['cannot delete tag "GA4 - Purchase": still used by tag "Ads - Linker" (11)']);
});

test("deleting a trigger inside a trigger group is refused", () => {
  const snap = fixture();
  snap.trigger!.push(
    { triggerId: "4", name: "Shop", type: "pageview" },
    { triggerId: "6", name: "Group", type: "triggerGroup", parameter: [{ type: "list", key: "triggerIds",
      list: [{ type: "triggerReference", value: "4" }] }] },
  );
  expect(problems([{ kind: "trigger", name: "Shop", delete: true }], snap))
    .toEqual(['cannot delete trigger "Shop": still used by trigger "Group" (6)']);
});

test("deleting a variable referenced only in a trigger's top-level field is refused", () => {
  const snap = fixture();
  (snap.trigger![0] as unknown as Record<string, unknown>).waitForTimeout = { type: "template", value: "{{JS - GPC Enabled}}" };
  expect(problems([{ kind: "variable", name: "JS - GPC Enabled", delete: true }], snap))
    .toEqual(['cannot delete variable "JS - GPC Enabled": still used by trigger "All Pages" (3)']);
});

test("renaming a variable still referenced is refused, and allowed when the spec patches the referrer", () => {
  const snap = () => {
    const s = fixture();
    s.tag![0]!.parameter = [{ type: "template", key: "eventName", value: "{{JS - GPC Enabled}}" }];
    return s;
  };
  const rename: SpecEntry = { kind: "variable", name: "JS - GPC Enabled", rename: "JS - GPC" };
  expect(problems([rename], snap()))
    .toEqual(['cannot rename variable "JS - GPC Enabled" to "JS - GPC": still used by tag "GA4 - Purchase" (10)']);

  const ops = buildPlan([rename, { kind: "tag", name: "GA4 - Purchase",
    parameter: [{ type: "template", key: "eventName", value: "{{JS - GPC}}" }] }], snap());
  expect(summary(ops)).toEqual(["update variable JS - GPC Enabled", "update tag GA4 - Purchase"]);

  // Also allowed when the same spec renames another variable to the old name.
  const withOther = snap();
  withOther.variable!.push({ variableId: "9", name: "Other", type: "c" });
  expect(summary(buildPlan([rename, { kind: "variable", name: "Other", rename: "JS - GPC Enabled" }], withOther)))
    .toEqual(["update variable JS - GPC Enabled", "update variable Other"]);
});

test("{paused:false} on an unpaused tag is unchanged", () => {
  expect(buildPlan([{ kind: "tag", name: "Ads - Linker", paused: false, notes: "" }], fixture()))
    .toEqual([{ action: "unchanged", kind: "tag", name: "Ads - Linker", id: "11" }]);
});
