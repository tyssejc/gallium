import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../cache/db.ts";
import { upsertEntity, recordVariableRef, recordTagTrigger, setMeta } from "../cache/repo.ts";
import { saveState } from "../config/state.ts";
import { statePath } from "../paths.ts";
import { listFor, cmdListEntities } from "./list.ts";
import { getFor, cmdTagsTriggers, cmdTriggersTags, cmdShow, cmdTag, cmdTrigger } from "./entity.ts";
import { cmdVariablesRefs, cmdRefs } from "./refs.ts";

let dir: string;
let logs: string[];
let errs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gallium-grammar-"));
  process.env.XDG_CACHE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  logs = []; errs = [];
  origLog = console.log; origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };

  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-09-02T00:00:00Z");
  upsertEntity(db, { id: "10", kind: "tag", name: "GA4 Event", type: "gaawe", paused: false,
    parentFolderId: null, rawJson: JSON.stringify({ tagId: "10", type: "gaawe" }), searchText: "" });
  upsertEntity(db, { id: "50", kind: "trigger", name: "All Pages", type: "pageview", paused: false,
    parentFolderId: null, rawJson: JSON.stringify({ triggerId: "50" }), searchText: "" });
  upsertEntity(db, { id: "v1", kind: "variable", name: "GA4 ID", type: "c", paused: false,
    parentFolderId: null, rawJson: JSON.stringify({ variableId: "v1" }), searchText: "" });
  upsertEntity(db, { id: "f1", kind: "folder", name: "Analytics", type: null, paused: false,
    parentFolderId: null, rawJson: JSON.stringify({ folderId: "f1" }), searchText: "" });
  // Same name on two kinds — the noun is what disambiguates in the new grammar.
  upsertEntity(db, { id: "99", kind: "tag", name: "Dup", type: "html", paused: false,
    parentFolderId: null, rawJson: JSON.stringify({ tagId: "99" }), searchText: "" });
  upsertEntity(db, { id: "v9", kind: "variable", name: "Dup", type: "c", paused: false,
    parentFolderId: null, rawJson: JSON.stringify({ variableId: "v9" }), searchText: "" });
  recordTagTrigger(db, "10", "50", "firing");
  recordVariableRef(db, "tag", "10", "GA4 ID");
  await saveState(statePath(), { default_container: "acme/web" });
});

afterEach(() => {
  console.log = origLog; console.error = origErr;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CACHE_HOME; delete process.env.XDG_CONFIG_HOME;
});

test("'tags list' lists tags", async () => {
  expect(await listFor("tag")([], { json: true })).toBe(0);
  const rows = JSON.parse(logs.join("\n"));
  expect(rows.map((r: any) => r.name).sort()).toEqual(["Dup", "GA4 Event"]);
});

test("'folders list' lists folders", async () => {
  expect(await listFor("folder")([], { json: true })).toBe(0);
  expect(JSON.parse(logs.join("\n")).map((r: any) => r.name)).toEqual(["Analytics"]);
});

test("'variables list --unused' still filters to unreferenced variables", async () => {
  expect(await listFor("variable")([], { json: true, unused: true })).toBe(0);
  const names = JSON.parse(logs.join("\n")).map((r: any) => r.name);
  expect(names).toContain("Dup");
  expect(names).not.toContain("GA4 ID");
});

test("the noun disambiguates a name shared by two kinds, with no --kind needed", async () => {
  expect(await getFor("tag")(["Dup"], {})).toBe(0);
  expect(JSON.parse(logs.join("\n")).tagId).toBe("99");
  logs.length = 0;
  expect(await getFor("variable")(["Dup"], {})).toBe(0);
  expect(JSON.parse(logs.join("\n")).variableId).toBe("v9");
});

test("'tags get' reports a name that exists only on another kind", async () => {
  await expect(getFor("tag")(["GA4 ID"], {})).rejects.toThrow(/No tag named 'GA4 ID'/);
});

test("'tags triggers' resolves the tag's firing triggers", async () => {
  expect(await cmdTagsTriggers(["GA4", "Event"], { json: true })).toBe(0);
  expect(JSON.parse(logs.join("\n"))).toEqual([{ relation: "firing", name: "All Pages", id: "50" }]);
});

test("'triggers tags' resolves the tags firing on the trigger", async () => {
  expect(await cmdTriggersTags(["All", "Pages"], { json: true })).toBe(0);
  expect(JSON.parse(logs.join("\n"))[0].name).toBe("GA4 Event");
});

test("'variables refs' resolves what references the variable", async () => {
  expect(await cmdVariablesRefs(["GA4", "ID"], { json: true })).toBe(0);
  expect(JSON.parse(logs.join("\n"))).toEqual([{ kind: "tag", name: "GA4 Event", id: "10" }]);
});

// The deprecated forms must keep working byte-for-byte on stdout so a stale
// installed SKILL.md and any existing scripts survive the upgrade; the warning
// goes to stderr precisely so --json output stays parseable.
const EQUIVALENT: [string, string, () => Promise<number>, () => Promise<number>][] = [
  ["gallium list tags", "gallium tags list",
    () => cmdListEntities(["tags"], { json: true }), () => listFor("tag")([], { json: true })],
  ["gallium show", "gallium tags get",
    () => cmdShow(["GA4 Event"], { kind: "tag" }), () => getFor("tag")(["GA4 Event"], {})],
  ["gallium tag", "gallium tags triggers",
    () => cmdTag(["GA4 Event"], { json: true }), () => cmdTagsTriggers(["GA4 Event"], { json: true })],
  ["gallium trigger", "gallium triggers tags",
    () => cmdTrigger(["All Pages"], { json: true }), () => cmdTriggersTags(["All Pages"], { json: true })],
  ["gallium refs", "gallium variables refs",
    () => cmdRefs(["GA4 ID"], { json: true }), () => cmdVariablesRefs(["GA4 ID"], { json: true })],
];

for (const [oldName, newName, oldCmd, newCmd] of EQUIVALENT) {
  test(`'${oldName}' warns on stderr and prints exactly what '${newName}' prints`, async () => {
    expect(await oldCmd()).toBe(0);
    const deprecatedOut = logs.join("\n");
    const warning = errs.join("\n");
    logs.length = 0; errs.length = 0;

    expect(await newCmd()).toBe(0);
    expect(deprecatedOut).toBe(logs.join("\n"));
    expect(errs.join("\n")).toBe("");

    expect(warning).toContain("deprecated");
    expect(warning).toContain(newName);
  });
}
