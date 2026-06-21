import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdLogin } from "./auth.ts";

test("cmdLogin throws 'No [oauth] block' when config has no oauth block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallium-auth-"));
  const orig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    // configPath() => ${XDG_CONFIG_HOME}/gallium/config.toml
    const cfgDir = join(dir, "gallium");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.toml"), `[containers."x/y"]
account_id = "1"
container_id = "2"
workspace_id = "3"
`);
    await expect(cmdLogin([], {})).rejects.toThrow(/No \[oauth\] block/);
  } finally {
    if (orig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
