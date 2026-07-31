import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../cache/db.ts";
import { upsertEntity, recordVariableRef, recordChange, setMeta } from "../cache/repo.ts";
import { saveState } from "../config/state.ts";
import { statePath } from "../paths.ts";
import { cmdRefs } from "./refs.ts";
import { cmdShow } from "./entity.ts";
import { cmdDirty } from "./diff.ts";
import { cmdContainerAdd, cmdContainerUse, cmdContainerPull, cmdContainerShow } from "./container.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";

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

test("cmdShow dumps an entity's full raw JSON including parameters", async () => {
  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-06-19T00:00:00Z");
  upsertEntity(db, { id: "145", kind: "tag", name: "GA4 Event | Generate Lead", type: "gaawe",
    paused: false, parentFolderId: null,
    rawJson: JSON.stringify({ tagId: "145", type: "gaawe", parameter: [{ key: "eventName", value: "{{Event}}" }] }),
    searchText: "" });
  await saveState(statePath(), { default_container: "acme/web" });
  const code = await cmdShow(["GA4 Event | Generate Lead"], { json: true });
  expect(code).toBe(0);
  const out = JSON.parse(logs.join("\n"));
  expect(out.tagId).toBe("145");
  expect(out.parameter[0]).toEqual({ key: "eventName", value: "{{Event}}" });
});

test("cmdShow errors on an ambiguous name without --kind", async () => {
  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-06-19T00:00:00Z");
  upsertEntity(db, { id: "1", kind: "tag", name: "Dup", type: "html",
    paused: false, parentFolderId: null, rawJson: "{}", searchText: "" });
  upsertEntity(db, { id: "2", kind: "trigger", name: "Dup", type: "customEvent",
    paused: false, parentFolderId: null, rawJson: "{}", searchText: "" });
  await saveState(statePath(), { default_container: "acme/web" });
  await expect(cmdShow(["Dup"], {})).rejects.toThrow(/multiple entities/);
});

test("cmdContainerAdd appends alias block and resolves via loadConfig", async () => {
  // Write a minimal config with just an [oauth] block
  const cfgDir = join(dir, "gallium");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.toml");
  await Bun.write(cfgPath, `[oauth]\nclient_id = "id"\nclient_secret = "secret"\n`);

  const code = await cmdContainerAdd(["acme/web", "111", "222", "3"], {});
  expect(code).toBe(0);

  const cfg = await loadConfig(cfgPath);
  const r = resolveContainer(cfg, "acme/web");
  expect(r.accountId).toBe("111");
  expect(r.containerId).toBe("222");
  expect(r.workspaceId).toBe("3");
});

test("cmdContainerAdd rejects duplicate alias", async () => {
  const cfgDir = join(dir, "gallium");
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.toml");
  await Bun.write(cfgPath, `[oauth]\nclient_id = "id"\nclient_secret = "secret"\n`);

  await cmdContainerAdd(["acme/web", "111", "222", "3"], {});
  await expect(cmdContainerAdd(["acme/web", "111", "222", "3"], {})).rejects.toThrow(/already exists/);
});

test("container commands reject a snapshot ref instead of silently ignoring it", async () => {
  const cfgDir = join(dir, "gallium");
  mkdirSync(cfgDir, { recursive: true });
  await Bun.write(join(cfgDir, "config.toml"), `[oauth]\nclient_id = "id"\nclient_secret = "s"\n`);
  await cmdContainerAdd(["acme/web", "111", "222", "3"], {});

  await expect(cmdContainerUse(["acme/web@v42"], {})).rejects.toThrow(/not a snapshot|snapshot ref/i);
  await expect(cmdContainerPull(["acme/web@live"], {})).rejects.toThrow(/not a snapshot|snapshot ref/i);
  await expect(cmdContainerShow([], { container: "acme/web@v42" })).rejects.toThrow(/not a snapshot|snapshot ref/i);
});

test("cmdDirty includes both pending changes and paused tags", async () => {
  const db = await openDb("acme/web");
  setMeta(db, "last_pulled_at", "2026-06-19T00:00:00Z");
  // A change entry
  upsertEntity(db, { id: "10", kind: "tag", name: "GA4 Event", type: "gaawe",
    paused: false, parentFolderId: null, rawJson: "{}", searchText: "" });
  recordChange(db, "tag", "10", "GA4 Event", "updated");
  // A paused tag
  upsertEntity(db, { id: "20", kind: "tag", name: "Paused Tag", type: "html",
    paused: true, parentFolderId: null, rawJson: "{}", searchText: "" });
  await saveState(statePath(), { default_container: "acme/web" });
  const code = await cmdDirty([], { json: true });
  expect(code).toBe(0);
  const rows = JSON.parse(logs.join("\n"));
  expect(rows.some((r: any) => r.id === "10" && r.change_status === "updated")).toBe(true);
  expect(rows.some((r: any) => r.id === "20" && r.change_status === "paused")).toBe(true);
});
