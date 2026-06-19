import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { grepCode } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium code search <pattern>
export const cmdCodeSearch: Cmd = async (positionals, flags) => {
  const pattern = positionals.join(" ").trim();
  if (!pattern) throw new Error("usage: gallium code search <pattern>");
  const db = await openPulled(await resolveAlias(flags));
  const rows = grepCode(db, pattern);
  console.log(format(rows, { json: !!flags.json, columns: ["kind", "name", "id"] }));
  return 0;
};
