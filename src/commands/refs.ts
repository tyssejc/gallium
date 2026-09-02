import type { Cmd } from "../command.ts";
import { openTarget } from "./_shared.ts";
import { refsToVariable } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium refs <variable name>
export const cmdRefs: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium refs <variable name>");
  const db = await openTarget(flags);
  const rows = refsToVariable(db, name);
  console.log(format(rows, { json: !!flags.json, columns: ["kind", "name", "id"] }));
  return 0;
};
