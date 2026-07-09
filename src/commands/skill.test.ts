import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { cmdSkillInstall } from "./skill.ts";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); delete process.env.CLAUDE_CONFIG_DIR; });

test("cmdSkillInstall copies SKILL.md to the install dir", async () => {
  dir = mkdtempSync(join(tmpdir(), "gallium-skill-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const orig = console.log; console.log = () => {};
  try { expect(await cmdSkillInstall([], {})).toBe(0); } finally { console.log = orig; }
  expect(existsSync(join(dir, "skills", "gallium", "SKILL.md"))).toBe(true);
  expect(existsSync(join(dir, "skills", "gallium", "references", "gtm-concepts.md"))).toBe(true);
});

// The in-process test above passes even when the skill files are unreachable from a
// compiled binary (import.meta.url resolves into bun's virtual /$bunfs). Only running
// the actual `--compile` artifact, detached from the source tree, catches that.
test("skill install works from a compiled binary with no source tree", async () => {
  dir = mkdtempSync(join(tmpdir(), "gallium-skill-compiled-"));
  const entry = resolve(import.meta.dir, "../../bin/gallium.ts");
  const bin = join(dir, "gallium");

  const built = Bun.spawnSync(["bun", "build", entry, "--compile", "--outfile", bin]);
  expect(built.exitCode).toBe(0);

  const run = Bun.spawnSync([bin, "skill", "install"], {
    cwd: tmpdir(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(dir, "skills", "gallium", "SKILL.md"))).toBe(true);
  expect(existsSync(join(dir, "skills", "gallium", "references", "gtm-concepts.md"))).toBe(true);
});
