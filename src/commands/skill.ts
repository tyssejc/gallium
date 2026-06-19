import type { Cmd } from "../command.ts";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillInstallDir } from "../paths.ts";

function skillSourceDir(): string {
  // src/commands/skill.ts → ../../src/skill
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
}

export const cmdSkillPath: Cmd = async () => { console.log(skillInstallDir()); return 0; };

export const cmdSkillInstall: Cmd = async () => {
  const dest = skillInstallDir();
  await cp(skillSourceDir(), dest, { recursive: true });
  console.log(`Installed gallium skill to ${dest}`);
  return 0;
};
