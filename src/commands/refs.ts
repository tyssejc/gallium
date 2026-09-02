import type { Cmd } from "../command.ts";
import { openTarget, deprecated } from "./_shared.ts";
import { refsToVariable } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium variables refs <name>  → every entity referencing {{name}}
export const cmdVariablesRefs: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium variables refs <variable name>");
  const db = await openTarget(flags);
  const rows = refsToVariable(db, name);
  console.log(format(rows, { json: !!flags.json, columns: ["kind", "name", "id"] }));
  return 0;
};

// Deprecated: gallium refs <name>
export const cmdRefs: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium refs <variable name>");
  deprecated(`gallium refs '${name}'`, `gallium variables refs '${name}'`);
  return cmdVariablesRefs(positionals, flags);
};
