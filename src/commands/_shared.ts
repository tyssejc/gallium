import type { Database } from "bun:sqlite";
import { openDb } from "../cache/db.ts";
import { getMeta, countEntities } from "../cache/repo.ts";
import { loadState } from "../config/state.ts";
import { statePath } from "../paths.ts";
import { parseContainerRef } from "../config/ref.ts";
import { openSnapshot } from "./_snapshot.ts";

export async function openPulled(alias: string): Promise<Database> {
  const db = await openDb(alias);
  if (!getMeta(db, "last_pulled_at")) {
    throw new Error(`Container '${alias}' has never been pulled. Run: gallium container pull ${alias}`);
  }
  // A pull recorded before the empty-ingest guard existed can leave a cache that
  // looks pulled but holds nothing. Answering from it would be a silent "no
  // results" to every question.
  if (countEntities(db) === 0) {
    throw new Error(
      `Cache for '${alias}' records a pull but contains no entities. Re-pull it: ` +
      `gallium container pull ${alias}`,
    );
  }
  return db;
}

export async function resolveAlias(flags: Record<string, unknown>, stateFile: string = statePath()): Promise<string> {
  const fromFlag = flags.container;
  if (typeof fromFlag === "string" && fromFlag.length > 0) return fromFlag;
  const state = await loadState(stateFile);
  if (state.default_container) return state.default_container;
  throw new Error("No container selected. Pass -c <alias>, or set a default with: gallium container use <alias>");
}

// The single entry point for analysis commands: resolves -c to either the
// workspace DB or an auto-pulled version snapshot.
export async function openTarget(flags: Record<string, unknown>): Promise<Database> {
  const ref = parseContainerRef(await resolveAlias(flags));
  if (!ref.snapshot) return openPulled(ref.alias);
  return (await openSnapshot(ref.alias, ref.snapshot)).db;
}

// Config and admin commands act on a configured container, not a point-in-time
// snapshot. Reject an @ref rather than quietly dropping the suffix.
export function requireWorkspaceAlias(raw: string): string {
  const ref = parseContainerRef(raw);
  if (ref.snapshot) {
    throw new Error(`'${raw}' is a snapshot ref; this command takes a container alias (e.g. '${ref.alias}').`);
  }
  return ref.alias;
}
