import type { Cmd } from "../command.ts";
import type { GtmEnvironment, GtmVersionHeader } from "../gtm/types.ts";
import { configPath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { parseContainerRef, parseAgainst, describeSnapshot } from "../config/ref.ts";
import { getUserToken } from "../auth/token.ts";
import { liveClient } from "../gtm/live.ts";
import { resolveAlias, deprecated } from "./_shared.ts";
import { openSnapshot, snapshotDbPath } from "./_snapshot.ts";
import { listEntities } from "../cache/repo.ts";
import { format } from "../output.ts";

const ENV_COLUMNS = ["name", "type", "environment_id", "version_id", "version_name"];
const VERSION_COLUMNS = ["version_id", "name", "deleted", "num_tags", "num_triggers", "num_variables"];
const DATED_COLUMNS = ["version_id", "created_at", "name", "deleted", "num_tags", "num_triggers", "num_variables"];
const DEFAULT_LIMIT = 20;

export interface EnvironmentRow {
  name: string; type: string; environment_id: string; version_id: string; version_name: string;
}
export interface VersionRow {
  version_id: string; name: string; deleted: boolean;
  num_tags: string; num_triggers: string; num_variables: string;
}

// An empty or "0" containerVersionId means the environment auto-tracks the
// newest publish rather than pinning a specific version.
export function environmentRows(envs: GtmEnvironment[], headers: GtmVersionHeader[]): EnvironmentRow[] {
  const nameById = new Map(headers.map((h) => [h.containerVersionId, h.name ?? ""]));
  return envs.map((e) => {
    const pinned = e.containerVersionId && e.containerVersionId !== "0" ? e.containerVersionId : null;
    return {
      name: e.name, type: e.type, environment_id: e.environmentId,
      version_id: pinned ?? "latest",
      version_name: pinned ? (nameById.get(pinned) ?? "") : "(tracks newest publish)",
    };
  });
}

// GTM stores `fingerprint` as epoch millis. It is recomputed on every write to
// the version, so it dates creation or last modification — renaming an old
// version moves it. Deliberately surfaced as `created_at`, never `published_at`.
export function fingerprintToIso(fingerprint?: string): string {
  const ms = Number(fingerprint);
  if (!fingerprint || !Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

export function attachDates(
  rows: VersionRow[], fingerprintById: Map<string, string>,
): (VersionRow & { created_at: string })[] {
  return rows.map((r) => ({ ...r, created_at: fingerprintToIso(fingerprintById.get(r.version_id)) }));
}

export function versionRows(headers: GtmVersionHeader[], limit: number): VersionRow[] {
  return headers
    .slice()
    .sort((a, b) => Number(b.containerVersionId) - Number(a.containerVersionId))
    .slice(0, limit)
    .map((h) => ({
      version_id: h.containerVersionId, name: h.name ?? "", deleted: !!h.deleted,
      num_tags: h.numTags ?? "", num_triggers: h.numTriggers ?? "", num_variables: h.numVariables ?? "",
    }));
}

// Both commands take a container ref only to locate the account/container; any
// @snapshot suffix is irrelevant here and is discarded after validation.
async function containerAndClient(flags: Record<string, unknown>) {
  const { alias } = parseContainerRef(await resolveAlias(flags));
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  return { r, client: liveClient(await getUserToken(cfg)) };
}

// gallium environments list [-c <ref>]
export const cmdEnvironmentsList: Cmd = async (_positionals, flags) => {
  const { r, client } = await containerAndClient(flags);
  const [envs, headers] = await Promise.all([
    client.listEnvironments(r.accountId, r.containerId),
    client.listVersionHeaders(r.accountId, r.containerId),
  ]);
  console.log(format(environmentRows(envs, headers), { json: !!flags.json, columns: ENV_COLUMNS }));
  return 0;
};

// gallium versions list [-c <ref>] [--limit N]
export const cmdVersionsList: Cmd = async (_positionals, flags) => {
  const limit = flags.limit === undefined ? DEFAULT_LIMIT : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer; got '${flags.limit}'`);
  }
  const { r, client } = await containerAndClient(flags);
  const headers = await client.listVersionHeaders(r.accountId, r.containerId);
  const rows = versionRows(headers, limit);

  if (!flags.dates) {
    console.log(format(rows, { json: !!flags.json, columns: VERSION_COLUMNS }));
    return 0;
  }
  // Version *headers* carry no fingerprint, so dating a listing costs one full
  // versions.get per row — each downloading that version's entire entity set.
  // Hence opt-in, and hence the warning.
  console.error(`# fetching ${rows.length} full version records to date them; this is slower than a plain listing`);
  const fingerprintById = new Map<string, string>();
  for (const row of rows) {
    const v = await client.getVersion(r.accountId, r.containerId, row.version_id);
    if (v.fingerprint) fingerprintById.set(row.version_id, v.fingerprint);
  }
  console.log(format(attachDates(rows, fingerprintById), { json: !!flags.json, columns: DATED_COLUMNS }));
  return 0;
};

// gallium versions get <versionId|env:name|live|latest> [-c <ref>]
// Prefetches a snapshot and prints what it resolved to. Analysis commands
// auto-pull too, so this exists for explicit prefetch and for stating the
// resolved target before answering a question.
export const cmdVersionsGet: Cmd = async (positionals, flags) => {
  const target = positionals[0];
  if (!target) throw new Error("usage: gallium versions get <versionId|env:name|live|latest> [-c <alias>]");
  const snap = parseAgainst(target);
  const { alias } = parseContainerRef(await resolveAlias(flags));
  const snapshot = await openSnapshot(alias, snap);
  const { db, versionId, versionName } = snapshot;
  console.log(format({
    alias,
    resolved_from: describeSnapshot(snap),
    version_id: versionId,
    version_name: versionName,
    description: snapshot.versionDescription,
    created_at: fingerprintToIso(snapshot.versionFingerprint),
    num_tags: listEntities(db, "tag").length,
    num_triggers: listEntities(db, "trigger").length,
    num_variables: listEntities(db, "variable").length,
    db_path: snapshotDbPath(alias, versionId),
  }, { json: !!flags.json }));
  return 0;
};

// Deprecated: gallium versions show <id>. Shipped in v0.2.0 and published to the
// Homebrew tap, so it gets a warning rather than a silent rename.
export const cmdVersionsShow: Cmd = async (positionals, flags) => {
  deprecated("gallium versions show", "gallium versions get");
  return cmdVersionsGet(positionals, flags);
};
