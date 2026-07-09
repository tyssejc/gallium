import type { Cmd } from "../command.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { skillInstallDir } from "../paths.ts";
// Embedded as text so `skill install` works from a compiled binary, where
// import.meta.url points into bun's virtual /$bunfs and no source tree exists.
import skillMd from "../skill/SKILL.md" with { type: "text" };
import gtmConcepts from "../skill/references/gtm-concepts.md" with { type: "text" };

export const cmdSkillPath: Cmd = async () => { console.log(skillInstallDir()); return 0; };

export const cmdSkillInstall: Cmd = async () => {
  const dest = skillInstallDir();
  await mkdir(join(dest, "references"), { recursive: true });
  await Bun.write(join(dest, "SKILL.md"), skillMd);
  await Bun.write(join(dest, "references", "gtm-concepts.md"), gtmConcepts);
  console.log(`Installed gallium skill to ${dest}`);
  return 0;
};
