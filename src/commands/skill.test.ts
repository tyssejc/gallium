import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
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
