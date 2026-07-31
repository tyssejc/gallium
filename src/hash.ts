// Fields that identify *where* an entity is stored rather than *what* it is.
// A version is a fresh stored copy of a workspace's entities, so GTM recomputes
// `fingerprint` and rewrites `path` for every one of them — comparing those would
// report total drift. Everything NOT listed here counts as content, including
// fields gallium does not model: a benign new API field will read as `updated`
// until it is added here, which is the safe direction to be wrong in.
export const STRIP_KEYS: ReadonlySet<string> = new Set([
  "path", "fingerprint", "accountId", "containerId",
  "workspaceId", "containerVersionId", "tagManagerUrl",
]);

export function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (STRIP_KEYS.has(key)) continue;
      out[key] = normalizeForHash(src[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(entity: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(normalizeForHash(entity)));
  return hasher.digest("hex");
}
