import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled, openTarget } from "./_shared.ts";
import { openSnapshot } from "./_snapshot.ts";
import { parseContainerRef, parseAgainst, describeSnapshot } from "../config/ref.ts";
import { compareSnapshots } from "../pull/compare.ts";
import { pendingChanges, listEntities } from "../cache/repo.ts";
import { format } from "../output.ts";

const COLUMNS = ["change_status", "kind", "name", "id"];

// gallium diff [--against <versionId|env:name|live|latest>]
// Without --against: the GTM API's own workspace status (pending vs live).
// With --against: a local comparison of two entity sets by content hash.
export const cmdDiff: Cmd = async (_positionals, flags) => {
  const raw = await resolveAlias(flags);
  const ref = parseContainerRef(raw);
  const against = flags.against as string | undefined;
  const status = flags.status as string | undefined;

  if (!against) {
    if (ref.snapshot) {
      throw new Error(
        `'diff' without --against compares a workspace against live, but '${raw}' is a version snapshot. ` +
        `Pass --against <versionId|env:name|live|latest>.`,
      );
    }
    const db = await openPulled(ref.alias);
    console.log(format(pendingChanges(db, { status }), { json: !!flags.json, columns: COLUMNS }));
    return 0;
  }

  // Parsed before any network call so bad input fails fast.
  const target = parseAgainst(against);
  const left = await openTarget(flags);
  const right = await openSnapshot(ref.alias, target);
  const rows = compareSnapshots(left, right.db)
    .filter((r) => !status || r.change_status === status);
  if (!flags.json) {
    console.error(`# comparing ${raw} against ${describeSnapshot(target)} (version ${right.versionId})`);
  }
  console.log(format(rows, { json: !!flags.json, columns: COLUMNS }));
  return 0;
};

// gallium dirty — pending changes PLUS paused entities (tags).
export const cmdDirty: Cmd = async (_positionals, flags) => {
  const db = await openTarget(flags);
  const changes = pendingChanges(db, { status: flags.status as string | undefined });
  const paused = listEntities(db, "tag", { pausedOnly: true })
    .map((e) => ({ change_status: "paused", kind: e.kind, name: e.name, id: e.id }));
  console.log(format([...changes, ...paused], { json: !!flags.json, columns: COLUMNS }));
  return 0;
};
