import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDbAt } from "./db.ts";
import { SCHEMA_VERSION } from "./schema.ts";

test("openDbAt builds schema on a fresh db and records the version", () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-db-fresh-"));
  const path = join(dir, "fresh.db");
  try {
    const db = openDbAt(path);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("entities");
    expect(tables).toContain("variable_refs");
    expect(tables).toContain("tag_triggers");
    expect(tables).toContain("changes");
    const ver = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(ver.value).toBe(String(SCHEMA_VERSION));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openDbAt rebuilds when stored schema_version mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-db-"));
  const path = join(dir, "t.db");
  try {
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    old.exec("INSERT INTO meta VALUES ('schema_version','0');");
    old.exec("CREATE TABLE entities (legacy TEXT);");
    old.close();
    const db = openDbAt(path);
    const cols = (db.query("PRAGMA table_info(entities)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("search_text");
    expect(cols).not.toContain("legacy");
    const ver = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
    expect(ver.value).toBe(String(SCHEMA_VERSION));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
