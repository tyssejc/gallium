import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { pendingChanges } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium diff  /  gallium dirty  — both surface pending workspace changes vs the live version.
export const cmdDiff: Cmd = async (_positionals, flags) => {
  const db = await openPulled(await resolveAlias(flags));
  const rows = pendingChanges(db, { status: flags.status as string | undefined });
  console.log(format(rows, { json: !!flags.json, columns: ["change_status", "kind", "name", "id"] }));
  return 0;
};
export const cmdDirty = cmdDiff;
