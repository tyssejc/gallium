import { parseArgs } from "node:util";
import type { Cmd } from "./command.ts";
import {
  cmdContainerInit, cmdContainerUse, cmdContainerShow, cmdContainerList, cmdContainerStatus, cmdContainerPull, cmdContainerAdd,
} from "./commands/container.ts";
import { cmdAccounts, cmdContainers, cmdWorkspaces } from "./commands/discover.ts";
import { cmdLogin } from "./commands/auth.ts";
import { cmdRefs } from "./commands/refs.ts";
import { cmdTag, cmdTrigger, cmdShow } from "./commands/entity.ts";
import { cmdCodeSearch } from "./commands/code.ts";
import { cmdDiff, cmdDirty } from "./commands/diff.ts";
import { cmdListEntities } from "./commands/list.ts";
import { cmdSkillInstall, cmdSkillPath } from "./commands/skill.ts";
import { cmdEnvironmentsList, cmdVersionsList, cmdVersionsShow } from "./commands/versionInfo.ts";
import { VERSION } from "./version.ts";

// Flat verb table for single-word commands; noun→verb for grouped ones.
const FLAT: Record<string, Cmd> = {
  login: cmdLogin, refs: cmdRefs, tag: cmdTag, trigger: cmdTrigger, show: cmdShow, diff: cmdDiff, dirty: cmdDirty, list: cmdListEntities,
  accounts: cmdAccounts, containers: cmdContainers, workspaces: cmdWorkspaces,
};
const GROUPED: Record<string, Record<string, Cmd>> = {
  container: { init: cmdContainerInit, use: cmdContainerUse, show: cmdContainerShow,
    list: cmdContainerList, status: cmdContainerStatus, pull: cmdContainerPull, add: cmdContainerAdd },
  code: { search: cmdCodeSearch },
  environments: { list: cmdEnvironmentsList },
  versions: { list: cmdVersionsList, show: cmdVersionsShow },
  skill: { install: cmdSkillInstall, path: cmdSkillPath },
};

function helpText(): string {
  const lines = ["gallium <command> [args] [--json] [-c <alias>]", "", "commands:",
    `  ${Object.keys(FLAT).join(", ")}`];
  for (const noun of Object.keys(GROUPED)) lines.push(`  ${noun}: ${Object.keys(GROUPED[noun]!).join(", ")}`);
  return lines.join("\n");
}

const OPTIONS = {
  json: { type: "boolean", default: false },
  paused: { type: "boolean", default: false },
  unused: { type: "boolean", default: false },
  refs: { type: "boolean", default: false },
  type: { type: "string" },
  kind: { type: "string" },
  folder: { type: "string" },
  status: { type: "string" },
  container: { type: "string", short: "c" },
  limit: { type: "string" },
  against: { type: "string" },
} as const;

export async function run(argv: string[]): Promise<number> {
  const [head, ...tail] = argv;
  if (head === "--version" || head === "-v") { console.log(VERSION); return 0; }
  if (!head || head === "--help" || head === "-h") { console.log(helpText()); return 0; }

  let fn: Cmd | undefined; let rest: string[];
  if (GROUPED[head]) {
    const verb = tail[0];
    fn = verb ? GROUPED[head]![verb] : undefined;
    if (!fn) { console.error(`Unknown '${head}' subcommand. Available: ${Object.keys(GROUPED[head]!).join(", ")}`); return 1; }
    rest = tail.slice(1);
  } else if (FLAT[head]) {
    fn = FLAT[head]; rest = tail;
  } else { console.error(`Unknown command: ${head}\n\n${helpText()}`); return 1; }

  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  return fn(positionals, values);
}
