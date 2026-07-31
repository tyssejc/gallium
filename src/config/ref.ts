export type SnapshotRef =
  | { kind: "version"; id: string }
  | { kind: "live" }
  | { kind: "latest" }
  | { kind: "env"; name: string };

export interface ContainerRef {
  alias: string;
  snapshot: SnapshotRef | null;
}

const CONTAINER_FORMS = "@v<N>, @live, @latest";
const AGAINST_FORMS = "<versionId>, env:<name>, live, latest";

// A container ref is `<alias>[@<snapshot>]`. Aliases may contain '/', never '@'.
export function parseContainerRef(raw: string): ContainerRef {
  if (raw.length === 0) throw new Error("Empty container ref.");
  const at = raw.lastIndexOf("@");
  if (at === -1) return { alias: raw, snapshot: null };
  const alias = raw.slice(0, at);
  const suffix = raw.slice(at + 1);
  if (alias.length === 0) throw new Error(`Container ref '${raw}' has no alias before '@'.`);
  if (suffix.startsWith("env:")) {
    throw new Error(`An environment is not a stable snapshot ref. Use --against env:<name> instead of '@${suffix}'.`);
  }
  if (suffix === "live") return { alias, snapshot: { kind: "live" } };
  if (suffix === "latest") return { alias, snapshot: { kind: "latest" } };
  const m = /^v(\d+)$/.exec(suffix);
  if (!m) throw new Error(`Invalid snapshot ref '@${suffix}' in '${raw}'. Valid forms: ${CONTAINER_FORMS}`);
  const id = m[1]!;
  if (/^0+$/.test(id)) {
    throw new Error("Version '@v0' means 'latest' to the GTM API and is not a stable snapshot. Use '@latest'.");
  }
  return { alias, snapshot: { kind: "version", id } };
}

// --against accepts everything a container ref does, plus env:<name>.
export function parseAgainst(raw: string): SnapshotRef {
  if (raw.startsWith("env:")) {
    const name = raw.slice(4);
    if (name.length === 0) throw new Error("'--against env:' needs an environment name, e.g. env:dev");
    return { kind: "env", name };
  }
  if (raw === "live") return { kind: "live" };
  if (raw === "latest") return { kind: "latest" };
  if (/^\d+$/.test(raw)) {
    if (/^0+$/.test(raw)) throw new Error("Version '0' means 'latest' to the GTM API. Use --against latest.");
    return { kind: "version", id: raw };
  }
  throw new Error(`Invalid --against target '${raw}'. Valid forms: ${AGAINST_FORMS}`);
}

export function describeSnapshot(s: SnapshotRef): string {
  switch (s.kind) {
    case "version": return `version ${s.id}`;
    case "live": return "the live version";
    case "latest": return "the latest version";
    case "env": return `environment '${s.name}'`;
  }
}
