import type { Database } from "bun:sqlite";
import type { SnapshotRef } from "../config/ref.ts";
import { configPath, versionDbPath } from "../paths.ts";
import { loadConfig, resolveContainer } from "../config/config.ts";
import { getUserToken } from "../auth/token.ts";
import { GtmClient } from "../gtm/client.ts";
import { openVersionDb } from "../cache/db.ts";
import { getMeta } from "../cache/repo.ts";
import { pullVersion } from "../pull/pull.ts";

// Named refs (@live/@latest/env:) resolve to a concrete id *before* a cache path
// is chosen, so they always follow the newest publish instead of going stale.
export async function resolveSnapshotVersionId(
  client: GtmClient, accountId: string, containerId: string, snap: SnapshotRef,
): Promise<string> {
  switch (snap.kind) {
    case "version":
      return snap.id;
    case "live": {
      const v = await client.getLiveVersion(accountId, containerId);
      if (!v.containerVersionId) throw new Error("Container has no live (published) version.");
      return v.containerVersionId;
    }
    case "latest": {
      const h = await client.getLatestVersionHeader(accountId, containerId);
      if (!h.containerVersionId) throw new Error("Container has no versions yet.");
      return h.containerVersionId;
    }
    case "env": {
      const envs = await client.listEnvironments(accountId, containerId);
      const match = envs.find((e) => e.name.toLowerCase() === snap.name.toLowerCase());
      if (!match) {
        const available = envs.map((e) => e.name).join(", ") || "(none)";
        throw new Error(`No environment named '${snap.name}'. Available: ${available}`);
      }
      if (!match.containerVersionId || match.containerVersionId === "0") {
        const h = await client.getLatestVersionHeader(accountId, containerId);
        if (!h.containerVersionId) {
          throw new Error(`Environment '${match.name}' tracks the latest version, but the container has no versions yet.`);
        }
        return h.containerVersionId;
      }
      return match.containerVersionId;
    }
  }
}

export interface OpenedSnapshot {
  db: Database; versionId: string; versionName: string;
  versionDescription: string; versionFingerprint: string;
}

// Versions are immutable, so a cached snapshot is never stale and is pulled at
// most once, ever.
export async function openSnapshot(alias: string, snap: SnapshotRef): Promise<OpenedSnapshot> {
  const cfg = await loadConfig(configPath());
  const r = resolveContainer(cfg, alias);
  const client = new GtmClient(await getUserToken(cfg));
  const versionId = await resolveSnapshotVersionId(client, r.accountId, r.containerId, snap);

  const db = await openVersionDb(alias, versionId);
  // `version_description` is absent (not merely empty) on snapshots cached before
  // it was recorded. Backfilling once beats reporting "no description" for a
  // version that has one — the schema bump that would also fix it costs every
  // container a full re-pull.
  if (!getMeta(db, "last_pulled_at") || getMeta(db, "version_description") === null) {
    await pullVersion(db, client, r.accountId, r.containerId, versionId, new Date().toISOString());
  }
  return {
    db, versionId,
    versionName: getMeta(db, "version_name") ?? "",
    versionDescription: getMeta(db, "version_description") ?? "",
    versionFingerprint: getMeta(db, "version_fingerprint") ?? "",
  };
}

export function snapshotDbPath(alias: string, versionId: string): string {
  return versionDbPath(alias, versionId);
}
