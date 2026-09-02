import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAlias, openPulled } from "./_shared.ts";
import { openDb } from "../cache/db.ts";
import { setMeta } from "../cache/repo.ts";
import { saveState } from "../config/state.ts";

test("resolveAlias prefers -c flag over state default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-rs-"));
  const sp = join(dir, "state.toml");
  try {
    await saveState(sp, { default_container: "from/state" });
    expect(await resolveAlias({ container: "from/flag" }, sp)).toBe("from/flag");
    expect(await resolveAlias({}, sp)).toBe("from/state");
    await expect(resolveAlias({}, join(dir, "missing.toml"))).rejects.toThrow(/No container selected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A cache poisoned by a pre-guard empty pull has last_pulled_at set but no
// entities, which would otherwise answer every question with "no results".
test("openPulled rejects a cache that recorded a pull but holds no entities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-empty-"));
  process.env.XDG_CACHE_HOME = dir;
  try {
    const db = await openDb("acme/web");
    setMeta(db, "last_pulled_at", "2026-09-02T00:00:00Z");
    await expect(openPulled("acme/web")).rejects.toThrow(/no entities.*container pull acme\/web/s);
  } finally {
    delete process.env.XDG_CACHE_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
