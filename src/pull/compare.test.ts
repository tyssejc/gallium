import { test, expect } from "bun:test";
import { openDbAt } from "../cache/db.ts";
import { upsertEntity } from "../cache/repo.ts";
import { compareSnapshots } from "./compare.ts";

function dbWith(entities: { id: string; kind: string; name: string; raw: unknown }[]) {
  const db = openDbAt(":memory:");
  for (const e of entities) {
    upsertEntity(db, { id: e.id, kind: e.kind, name: e.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(e.raw), searchText: "" });
  }
  return db;
}

test("identical content with different location fields produces an empty diff", () => {
  const ws = dbWith([{ id: "10", kind: "tag", name: "GA4", raw: {
    tagId: "10", name: "GA4", fingerprint: "aaa", workspaceId: "3",
    path: "accounts/1/containers/2/workspaces/3/tags/10" } }]);
  const ver = dbWith([{ id: "10", kind: "tag", name: "GA4", raw: {
    tagId: "10", name: "GA4", fingerprint: "zzz", containerVersionId: "42",
    path: "accounts/1/containers/2/versions/42/tags/10" } }]);
  expect(compareSnapshots(ws, ver)).toEqual([]);
});

test("classifies added, updated, and deleted", () => {
  const left = dbWith([
    { id: "10", kind: "tag", name: "Changed", raw: { tagId: "10", name: "Changed", paused: true } },
    { id: "11", kind: "tag", name: "New Tag", raw: { tagId: "11", name: "New Tag" } },
    { id: "12", kind: "tag", name: "Same", raw: { tagId: "12", name: "Same" } },
  ]);
  const right = dbWith([
    { id: "10", kind: "tag", name: "Changed", raw: { tagId: "10", name: "Changed", paused: false } },
    { id: "12", kind: "tag", name: "Same", raw: { tagId: "12", name: "Same" } },
    { id: "13", kind: "tag", name: "Removed Tag", raw: { tagId: "13", name: "Removed Tag" } },
  ]);
  expect(compareSnapshots(left, right)).toEqual([
    { change_status: "added", kind: "tag", name: "New Tag", id: "11" },
    { change_status: "deleted", kind: "tag", name: "Removed Tag", id: "13" },
    { change_status: "updated", kind: "tag", name: "Changed", id: "10" },
  ]);
});

test("the same id in different kinds is not confused", () => {
  const left = dbWith([
    { id: "1", kind: "tag", name: "T", raw: { a: 1 } },
    { id: "1", kind: "trigger", name: "G", raw: { a: 1 } },
  ]);
  const right = dbWith([{ id: "1", kind: "tag", name: "T", raw: { a: 1 } }]);
  expect(compareSnapshots(left, right)).toEqual([
    { change_status: "added", kind: "trigger", name: "G", id: "1" },
  ]);
});

test("a deleted row reports the name from the baseline side", () => {
  const left = dbWith([]);
  const right = dbWith([{ id: "9", kind: "variable", name: "Old Var", raw: { a: 1 } }]);
  expect(compareSnapshots(left, right)).toEqual([
    { change_status: "deleted", kind: "variable", name: "Old Var", id: "9" },
  ]);
});

test("two empty snapshots compare clean", () => {
  expect(compareSnapshots(dbWith([]), dbWith([]))).toEqual([]);
});
