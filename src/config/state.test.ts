import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadState, saveState } from "./state.ts";

test("state round-trips default_container", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-state-"));
  const path = join(dir, "state.toml");
  try {
    expect(await loadState(path)).toEqual({});
    await saveState(path, { default_container: "acme/web" });
    expect(await loadState(path)).toEqual({ default_container: "acme/web" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
