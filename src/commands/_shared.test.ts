import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAlias } from "./_shared.ts";
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
