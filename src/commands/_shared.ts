import type { Database } from "bun:sqlite";
import { openDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { loadState } from "../config/state.ts";
import { statePath } from "../paths.ts";

export async function openPulled(alias: string): Promise<Database> {
  const db = await openDb(alias);
  if (!getMeta(db, "last_pulled_at")) {
    throw new Error(`Container '${alias}' has never been pulled. Run: gallium container pull ${alias}`);
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
