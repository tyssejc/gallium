import { dirname, resolve } from "node:path";
import type { WriteKind } from "../gtm/types.ts";

export interface SpecEntry {
  kind: WriteKind; name: string;
  delete?: boolean; rename?: string; folder?: string;
  firingTriggers?: string[]; blockingTriggers?: string[];
  addFiringTriggers?: string[]; removeFiringTriggers?: string[];
  addBlockingTriggers?: string[]; removeBlockingTriggers?: string[];
  [field: string]: unknown;   // any GTM API field, passed through
}

export const WRITE_KINDS: readonly WriteKind[] = ["tag", "trigger", "variable", "folder"];

export const TRIGGER_LIST_HELPERS = [
  "firingTriggers", "blockingTriggers",
  "addFiringTriggers", "removeFiringTriggers",
  "addBlockingTriggers", "removeBlockingTriggers",
] as const;

export const normName = (name: string): string => name.trim().toLowerCase();

// Replaces every `valueFile` (at any depth) with `value` read from that path,
// relative to the spec file. Returns the paths that could not be read.
async function inlineValueFiles(node: unknown, baseDir: string): Promise<string[]> {
  if (Array.isArray(node)) {
    return (await Promise.all(node.map((n) => inlineValueFiles(n, baseDir)))).flat();
  }
  if (node === null || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj.valueFile === "string") {
    const file = Bun.file(resolve(baseDir, obj.valueFile));
    if (await file.exists()) {
      obj.value = await file.text();
      delete obj.valueFile;
    } else {
      missing.push(file.name!);
    }
  }
  for (const v of Object.values(obj)) missing.push(...await inlineValueFiles(v, baseDir));
  return missing;
}

function entryProblems(e: unknown): string[] {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return ["must be an object"];
  const entry = e as Record<string, unknown>;
  const out: string[] = [];
  if (typeof entry.kind !== "string") out.push("kind is required");
  else if (!WRITE_KINDS.includes(entry.kind as WriteKind)) {
    out.push(`kind must be one of ${WRITE_KINDS.join(", ")} (got "${entry.kind}")`);
  }
  if (typeof entry.name !== "string" || !entry.name.trim()) out.push("name is required");
  for (const key of ["rename", "folder"]) {
    if (key in entry && typeof entry[key] !== "string") out.push(`${key} must be a string`);
  }
  for (const key of TRIGGER_LIST_HELPERS) {
    if (!(key in entry)) continue;
    if (entry.kind !== "tag") out.push(`${key} applies only to a tag`);
    const v = entry[key];
    if (!Array.isArray(v) || v.some((n) => typeof n !== "string")) out.push(`${key} must be an array of trigger names`);
  }
  if ("delete" in entry) {
    if (entry.delete !== true) out.push("delete must be true");
    const others = Object.keys(entry).filter((k) => !["kind", "name", "delete"].includes(k));
    if (others.length) out.push(`delete cannot be combined with other fields (${others.join(", ")})`);
  }
  return out;
}

// Reads and validates a spec file. Every problem across every entry is
// reported in one error, numbered by zero-based entry index.
export async function loadSpec(path: string): Promise<SpecEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(path).text());
  } catch (e) {
    throw new Error(`spec ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`spec ${path} must be a JSON array of entries`);

  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const [i, e] of raw.entries()) {
    const own = entryProblems(e);
    problems.push(...own.map((p) => `entry ${i}: ${p}`));
    if (own.length) continue;
    const entry = e as SpecEntry;
    const key = `${entry.kind}\0${normName(entry.name)}`;
    const first = seen.get(key);
    if (first !== undefined) problems.push(`entry ${i}: duplicate of entry ${first} (${entry.kind} "${entry.name.trim()}")`);
    else seen.set(key, i);
    for (const p of await inlineValueFiles(entry, dirname(path))) problems.push(`entry ${i}: valueFile not found: ${p}`);
  }
  if (problems.length) throw new Error(`spec ${path} is invalid:\n  ${problems.join("\n  ")}`);
  return raw as SpecEntry[];
}
