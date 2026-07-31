import type { Database } from "bun:sqlite";
import { allEntityHashes } from "../cache/repo.ts";

export interface DiffRow {
  change_status: string; kind: string; name: string; id: string;
}

// GTM has no version-vs-version diff API, so classify locally. `left` is the
// side being judged (workspace or newer version); `right` is the baseline.
// Entity ids survive publishing, so (kind, id) is the join key.
export function compareSnapshots(left: Database, right: Database): DiffRow[] {
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const baseline = new Map(allEntityHashes(right).map((e) => [key(e.kind, e.id), e]));
  const rows: DiffRow[] = [];

  for (const e of allEntityHashes(left)) {
    const k = key(e.kind, e.id);
    const other = baseline.get(k);
    if (!other) {
      rows.push({ change_status: "added", kind: e.kind, name: e.name, id: e.id });
    } else if (other.content_hash !== e.content_hash) {
      rows.push({ change_status: "updated", kind: e.kind, name: e.name, id: e.id });
    }
    baseline.delete(k);
  }
  // Whatever is left in the baseline exists only there.
  for (const e of baseline.values()) {
    rows.push({ change_status: "deleted", kind: e.kind, name: e.name, id: e.id });
  }

  return rows.sort((a, b) =>
    a.change_status.localeCompare(b.change_status) ||
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name));
}
