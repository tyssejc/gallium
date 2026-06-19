import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../cache/db.ts";
import { upsertEntity, recordVariableRef, setMeta } from "../cache/repo.ts";
import { saveState } from "../config/state.ts";
import { statePath } from "../paths.ts";
import { cmdRefs } from "./refs.ts";

let dir: string;
let logs: string[];
let origLog: typeof console.log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gallium-cmd-"));
  process.env.XDG_CACHE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  logs = []; origLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
});
afterEach(() => { console.log = origLog; rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CACHE_HOME; delete process.env.XDG_CONFIG_HOME; });

test("cmdRefs prints entities referencing a variable as JSON", async () => {
  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-06-19T00:00:00Z");
  upsertEntity(db, { id: "10", kind: "tag", name: "GA4 Event", type: "gaawe",
    paused: false, parentFolderId: null, rawJson: "{}", searchText: "" });
  recordVariableRef(db, "tag", "10", "GA4 ID");
  await saveState(statePath(), { default_container: "acme/web" });
  const code = await cmdRefs(["GA4", "ID"], { json: true });
  expect(code).toBe(0);
  expect(JSON.parse(logs.join("\n"))).toEqual([{ kind: "tag", name: "GA4 Event", id: "10" }]);
});
