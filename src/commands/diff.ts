import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { pendingChanges, listEntities } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium diff — pending workspace changes vs the live version.
export const cmdDiff: Cmd = async (_positionals, flags) => {
  const db = await openPulled(await resolveAlias(flags));
  const rows = pendingChanges(db, { status: flags.status as string | undefined });
  console.log(format(rows, { json: !!flags.json, columns: ["change_status", "kind", "name", "id"] }));
  return 0;
};

// gallium dirty — pending changes PLUS paused entities (tags).
export const cmdDirty: Cmd = async (_positionals, flags) => {
  const db = await openPulled(await resolveAlias(flags));
  const changes = pendingChanges(db, { status: flags.status as string | undefined });
  const paused = listEntities(db, "tag", { pausedOnly: true })
    .map((e) => ({ change_status: "paused", kind: e.kind, name: e.name, id: e.id }));
  const rows = [...changes, ...paused];
  console.log(format(rows, { json: !!flags.json, columns: ["change_status", "kind", "name", "id"] }));
  return 0;
};
