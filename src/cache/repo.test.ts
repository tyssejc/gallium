import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDbAt } from "./db.ts";
import {
  upsertEntity, recordVariableRef, recordTagTrigger, recordChange,
  refsToVariable, tagFiringTriggers, tagsFiringOnTrigger, grepCode,
  listEntities, unusedVariables, pendingChanges, findEntityByName, setMeta, getMeta,
} from "./repo.ts";

function db(): Database { return openDbAt(":memory:"); }
const ent = (over: Partial<any>) => ({ id: "x", kind: "tag", name: "X", type: "html",
  paused: false, parentFolderId: null, rawJson: "{}", searchText: "x", ...over });

test("refsToVariable returns entities that reference {{name}}", () => {
  const d = db();
  upsertEntity(d, ent({ id: "10", kind: "tag", name: "GA4 Event" }));
  recordVariableRef(d, "tag", "10", "GA4 ID");
  expect(refsToVariable(d, "GA4 ID")).toEqual([{ kind: "tag", id: "10", name: "GA4 Event" }]);
});

test("tag/trigger relations resolve both directions", () => {
  const d = db();
  upsertEntity(d, ent({ id: "10", kind: "tag", name: "GA4 Event" }));
  upsertEntity(d, ent({ id: "50", kind: "trigger", name: "All Pages", type: "pageview" }));
  recordTagTrigger(d, "10", "50", "firing");
  expect(tagFiringTriggers(d, "10")).toEqual([{ id: "50", name: "All Pages", relation: "firing" }]);
  expect(tagsFiringOnTrigger(d, "50")).toEqual([{ tag_id: "10", name: "GA4 Event", relation: "firing" }]);
});

test("grepCode matches search_text and treats _ literally", () => {
  const d = db();
  upsertEntity(d, ent({ id: "1", searchText: "datalayer.page_name = 1" }));
  upsertEntity(d, ent({ id: "2", searchText: "datalayerxpagexname" }));
  expect(grepCode(d, "page_name").map((r) => r.id)).toEqual(["1"]);
});

test("unusedVariables flags variables referenced nowhere", () => {
  const d = db();
  upsertEntity(d, ent({ id: "v1", kind: "variable", name: "Used", type: "jsm" }));
  upsertEntity(d, ent({ id: "v2", kind: "variable", name: "Orphan", type: "jsm" }));
  recordVariableRef(d, "tag", "10", "Used");
  expect(unusedVariables(d)).toEqual([{ id: "v2", name: "Orphan" }]);
});

test("listEntities filters by type/folder/paused; pendingChanges filters by status", () => {
  const d = db();
  upsertEntity(d, ent({ id: "1", kind: "tag", type: "html", paused: true, parentFolderId: "9" }));
  upsertEntity(d, ent({ id: "2", kind: "tag", type: "gaawe", paused: false }));
  expect(listEntities(d, "tag", { type: "html" }).map((r) => r.id)).toEqual(["1"]);
  expect(listEntities(d, "tag", { pausedOnly: true }).map((r) => r.id)).toEqual(["1"]);
  recordChange(d, "tag", "2", "B", "updated");
  expect(pendingChanges(d, {}).map((c) => c.id)).toEqual(["2"]);
  expect(pendingChanges(d, { status: "added" })).toEqual([]);
});

test("meta round-trips and findEntityByName is case-insensitive", () => {
  const d = db();
  setMeta(d, "last_pulled_at", "2026-06-19T00:00:00Z");
  expect(getMeta(d, "last_pulled_at")).toBe("2026-06-19T00:00:00Z");
  upsertEntity(d, ent({ id: "7", kind: "trigger", name: "All Pages" }));
  expect(findEntityByName(d, "trigger", "all pages")?.id).toBe("7");
});
