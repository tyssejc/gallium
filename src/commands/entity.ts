import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { findEntityByName, tagFiringTriggers, tagsFiringOnTrigger } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium tag <name>  → its firing/blocking triggers
export const cmdTag: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium tag <name>");
  const db = await openPulled(await resolveAlias(flags));
  const tag = findEntityByName(db, "tag", name);
  if (!tag) throw new Error(`No tag named '${name}'`);
  const rows = tagFiringTriggers(db, tag.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "id"] }));
  return 0;
};

// gallium trigger <name> [--refs]  → tags that fire on it
export const cmdTrigger: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium trigger <name> [--refs]");
  const db = await openPulled(await resolveAlias(flags));
  const trig = findEntityByName(db, "trigger", name);
  if (!trig) throw new Error(`No trigger named '${name}'`);
  const rows = tagsFiringOnTrigger(db, trig.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "tag_id"] }));
  return 0;
};
