import type { WriteKind } from "../gtm/types.ts";
import type { EntitySnapshot } from "../pull/pull.ts";
import { entityStrings, extractVariableRefs } from "../pull/classify.ts";
import { normalizeForHash } from "../hash.ts";
import { normName, TRIGGER_LIST_HELPERS, WRITE_KINDS, type SpecEntry } from "./spec.ts";

export interface Op {
  action: "create" | "update" | "delete" | "unchanged";
  kind: WriteKind; name: string;
  id?: string; fingerprint?: string;   // update, delete
  body?: Record<string, unknown>;      // create, update
  changed?: string[];                  // update: top-level API fields that differ
}

export const newRef = (kind: WriteKind, name: string): string => `@new:${kind}:${name.toLowerCase()}`;

export class PlanError extends Error {
  constructor(public problems: string[]) {
    super(`plan has ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
    this.name = "PlanError";
  }
}

type Body = Record<string, unknown>;

const ID_FIELD: Record<WriteKind, string> = { tag: "tagId", trigger: "triggerId", variable: "variableId", folder: "folderId" };
const NOT_IN_BODY: ReadonlySet<string> = new Set(["kind", "name", "delete", "rename", "folder", ...TRIGGER_LIST_HELPERS]);
const WRITE_ORDER: WriteKind[] = ["folder", "variable", "trigger", "tag"];

// One entity in the post-plan state. `stored` is the workspace's copy (absent
// for creates); `name` and `body` are what the entity will be after the plan.
interface Node { kind: WriteKind; id: string; name: string; body: Body; stored?: Body; deleted: boolean; }

interface Work { entry: SpecEntry; label: string; node: Node; }

const idsOf = (nodes: Node[]) => nodes.map((n) => n.id).join(", ");

// Top-level fields whose canonical JSON differs. An empty array counts as
// absent: GTM omits empty lists, so treating `[]` as a change would never converge.
function changedFields(stored: Body, body: Body): string[] {
  const a = normalizeForHash(stored) as Body;
  const b = normalizeForHash(body) as Body;
  const canon = (v: unknown) => (Array.isArray(v) && v.length === 0 ? undefined : JSON.stringify(v));
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => canon(a[k]) !== canon(b[k])).sort();
}

const variableRefs = (n: Node): string[] =>
  n.kind === "folder" ? [] : extractVariableRefs(entityStrings(n.kind, n.body));

export function buildPlan(entries: SpecEntry[], snap: EntitySnapshot): Op[] {
  const problems: string[] = [];
  const ops: Op[] = [];
  const nodes: Node[] = WRITE_KINDS.flatMap((kind) =>
    ((snap[kind] ?? []) as unknown as Body[]).map((e): Node => ({
      kind, id: e[ID_FIELD[kind]] as string, name: e.name as string, body: e, stored: e, deleted: false,
    })));

  const storedNamed = (kind: WriteKind, name: string) =>
    nodes.filter((n) => n.stored && n.kind === kind && normName(n.stored.name as string) === normName(name));
  const liveNamed = (kind: WriteKind, name: string) =>
    nodes.filter((n) => !n.deleted && n.kind === kind && normName(n.name) === normName(name));

  // Pass 1: match each entry to a stored entity (by name, else by its rename
  // target) and settle the post-plan names, so later lookups see renames,
  // creates and deletes regardless of entry order.
  const writes: Work[] = [];
  const deletes: Work[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    const label = `${entry.kind} "${name}"`;
    let found = storedNamed(entry.kind, name);
    if (!found.length && entry.rename) found = storedNamed(entry.kind, entry.rename);
    if (found.length > 1) {
      problems.push(`${label} matches ${found.length} ${entry.kind}s (ids ${idsOf(found)})`);
      continue;
    }
    const target = found[0];
    if (entry.delete) {
      if (!target) ops.push({ action: "unchanged", kind: entry.kind, name });
      else { target.deleted = true; deletes.push({ entry, label, node: target }); }
    } else if (target) {
      if (entry.rename) target.name = entry.rename.trim();
      writes.push({ entry, label, node: target });
    } else if (entry.rename) {
      problems.push(`${label}: cannot rename, no ${entry.kind} named "${name}" or "${entry.rename.trim()}"`);
    } else if (entry.kind !== "folder" && !entry.type) {
      problems.push(`${label}: create requires type`);
    } else {
      const node: Node = { kind: entry.kind, id: newRef(entry.kind, name), name, body: {}, deleted: false };
      nodes.push(node);
      writes.push({ entry, label, node });
    }
  }

  const resolveId = (kind: "trigger" | "folder", name: string, label: string): string | undefined => {
    const found = liveNamed(kind, name);
    if (found.length === 1) return found[0]!.id;
    problems.push(found.length
      ? `${label}: ${kind} "${name.trim()}" matches ${found.length} ${kind}s (ids ${idsOf(found)})`
      : `${label}: ${kind} "${name.trim()}" not found`);
  };
  const resolveAll = (names: string[], label: string): string[] =>
    names.map((n) => resolveId("trigger", n, label)).filter((id): id is string => id !== undefined);

  // Removal matches the current or post-plan name and tolerates an absent
  // trigger, so a re-run after the trigger is deleted stays unchanged.
  const removalIds = (names: string[]): Set<string> => new Set(names.flatMap((name) =>
    nodes.filter((n) => n.kind === "trigger"
      && (normName(n.name) === normName(name) || (n.stored && normName(n.stored.name as string) === normName(name))))
      .map((n) => n.id)));

  const applyTriggerList = (body: Body, field: string, label: string, set?: string[], add?: string[], remove?: string[]) => {
    if (!set && !add && !remove) return;
    const ids = set ? resolveAll(set, label) : [...((body[field] as string[] | undefined) ?? [])];
    for (const id of resolveAll(add ?? [], label)) if (!ids.includes(id)) ids.push(id);
    const drop = removalIds(remove ?? []);
    body[field] = ids.filter((id) => !drop.has(id));
  };

  // Pass 2: build each body against the post-plan state.
  for (const { entry, label, node } of writes) {
    const body: Body = node.stored ? structuredClone(node.stored) : {};
    for (const [key, value] of Object.entries(entry)) if (!NOT_IN_BODY.has(key)) body[key] = value;
    body.name = node.name;
    if (entry.folder !== undefined) {
      const id = resolveId("folder", entry.folder, label);
      if (id) body.parentFolderId = id;
    }
    applyTriggerList(body, "firingTriggerId", label, entry.firingTriggers, entry.addFiringTriggers, entry.removeFiringTriggers);
    applyTriggerList(body, "blockingTriggerId", label, entry.blockingTriggers, entry.addBlockingTriggers, entry.removeBlockingTriggers);
    node.body = body;
  }

  // Pass 3: classify writes and check their {{variable}} references.
  const variableNames = new Set([
    ...nodes.filter((n) => n.kind === "variable" && !n.deleted).map((n) => n.name),
    ...(snap.builtInVariable ?? []).map((b) => b.name),
  ]);
  for (const { label, node } of writes) {
    const base = { kind: node.kind, name: node.stored ? (node.stored.name as string) : node.name };
    if (!node.stored) {
      ops.push({ action: "create", ...base, body: node.body });
    } else {
      const changed = changedFields(node.stored, node.body);
      if (!changed.length) { ops.push({ action: "unchanged", ...base, id: node.id }); continue; }
      const fp = node.stored.fingerprint as string | undefined;
      ops.push({ action: "update", ...base, id: node.id, ...(fp && { fingerprint: fp }), body: node.body, changed });
    }
    for (const ref of variableRefs(node)) {
      if (!ref.startsWith("_") && !variableNames.has(ref)) problems.push(`${label}: {{${ref}}} is not a variable or enabled built-in`);
    }
  }

  // Pass 4: a delete is refused while anything surviving the plan still uses it.
  const survivors = nodes.filter((n) => !n.deleted);
  const uses = (n: Node, target: Node): boolean => {
    if (target.kind === "trigger") {
      return n.kind === "tag" && [...((n.body.firingTriggerId as string[]) ?? []), ...((n.body.blockingTriggerId as string[]) ?? [])].includes(target.id);
    }
    if (target.kind === "variable") return variableRefs(n).includes(target.stored!.name as string);
    return n.body.parentFolderId === target.id;
  };
  for (const { node } of deletes) {
    const name = node.stored!.name as string;
    for (const user of survivors.filter((n) => uses(n, node))) {
      problems.push(`cannot delete ${node.kind} "${name}": still used by ${user.kind} "${user.name}" (${user.id})`);
    }
    const fp = node.stored!.fingerprint as string | undefined;
    ops.push({ action: "delete", kind: node.kind, name, id: node.id, ...(fp && { fingerprint: fp }) });
  }

  if (problems.length) throw new PlanError(problems);

  const rank = (op: Op): number =>
    op.action === "unchanged" ? 8
      : op.action === "delete" ? 7 - WRITE_ORDER.indexOf(op.kind)
        : WRITE_ORDER.indexOf(op.kind);
  return ops.sort((a, b) => rank(a) - rank(b));
}
