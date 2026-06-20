import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { listEntities, unusedVariables } from "../cache/repo.ts";
import { format } from "../output.ts";

const KINDS: Record<string, string> = {
  tags: "tag", triggers: "trigger", variables: "variable", folders: "folder",
};

// gallium list <tags|triggers|variables|folders> [--type X] [--folder ID] [--paused] [--unused]
export const cmdListEntities: Cmd = async (positionals, flags) => {
  const kindArg = positionals[0];
  const kind = KINDS[kindArg ?? ""];
  if (!kind) throw new Error(`usage: gallium list <${Object.keys(KINDS).join("|")}> [filters]`);
  const db = await openPulled(await resolveAlias(flags));
  if (flags.unused && kind !== "variable") {
    console.error("note: --unused only applies to 'list variables'; ignoring");
  }
  if (kind === "variable" && flags.unused) {
    console.log(format(unusedVariables(db), { json: !!flags.json, columns: ["name", "id"] }));
    return 0;
  }
  const rows = listEntities(db, kind, {
    type: flags.type as string | undefined,
    folderId: flags.folder as string | undefined,
    pausedOnly: !!flags.paused,
  }).map((r) => ({ name: r.name, type: r.type, id: r.id, paused: r.paused }));
  console.log(format(rows, { json: !!flags.json, columns: ["name", "type", "id", "paused"] }));
  return 0;
};
