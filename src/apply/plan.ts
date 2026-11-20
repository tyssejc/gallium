import type { WriteKind } from "../gtm/types.ts";
import type { EntitySnapshot } from "../pull/pull.ts";
import { extractVariableRefs } from "../pull/classify.ts";
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

export const ID_FIELD: Record<WriteKind, string> = { tag: "tagId", trigger: "triggerId", variable: "variableId", folder: "folderId" };
const NOT_IN_BODY: ReadonlySet<string> = new Set(["kind", "name", "delete", "rename", "folder", ...TRIGGER_LIST_HELPERS]);
const WRITE_ORDER: WriteKind[] = ["folder", "variable", "trigger", "tag"];

// One entity in the post-plan state. `stored` is the workspace's copy (absent
// for creates); `name` and `body` are what the entity will be after the plan.
interface Node { kind: WriteKind; id: string; name: string; body: Body; stored?: Body; deleted: boolean; }

interface Work { entry: SpecEntry; label: string; node: Node; }

const idsOf = (nodes: Node[]) => nodes.map((n) => n.id).join(", ");

// Top-level fields whose canonical JSON differs. `false`, `""` and `[]` count
// as absent: GTM omits default values, so treating them as changes would never converge.
function changedFields(stored: Body, body: Body): string[] {
  const a = normalizeForHash(stored) as Body;
  const b = normalizeForHash(body) as Body;
  const canon = (v: unknown) =>
    v === false || v === "" || (Array.isArray(v) && v.length === 0) ? undefined : JSON.stringify(v);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => canon(a[k]) !== canon(b[k])).sort();
}

function* valuesIn(v: unknown): Generator<unknown> {
  yield v;
  if (Array.isArray(v)) for (const x of v) yield* valuesIn(x);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v)) yield* valuesIn(x);
}

// Every value anywhere in a body except its own `name` and `notes`, which
// GTM does not resolve references in.
const bodyValues = (body: Body): unknown[] =>
  Object.entries(body).filter(([k]) => k !== "name" && k !== "notes").flatMap(([, v]) => [...valuesIn(v)]);

const variableRefs = (n: Node): string[] =>
  extractVariableRefs(bodyValues(n.body).filter((v): v is string => typeof v === "string"));

const hasParam = (n: Node, type: string, value: string): boolean =>
  bodyValues(n.body).some((v) => v !== null && typeof v === "object"
    && (v as Body).type === type && (v as Body).value === value);

const listOf = (body: Body, field: string): unknown[] => (Array.isArray(body[field]) ? body[field] as unknown[] : []);

// Whether `n` references `target`. Triggers and folders are referenced by id;
// variables and tags by name, so a rename check passes the old name.
function references(n: Node, target: Node, name: string): boolean {
  switch (target.kind) {
    case "trigger":
      return (n.kind === "tag" && [...listOf(n.body, "firingTriggerId"), ...listOf(n.body, "blockingTriggerId")].includes(target.id))
        || hasParam(n, "triggerReference", target.id);
    case "variable":
      return variableRefs(n).includes(name);
    case "tag":
      return (n.kind === "tag" && [...listOf(n.body, "setupTag"), ...listOf(n.body, "teardownTag")]
        .some((s) => (s as Body | null)?.tagName === name))
        || hasParam(n, "tagReference", name);
    case "folder":
      return n.body.parentFolderId === target.id;
    default: {
      const unknown: never = target.kind;
      throw new Error(`no reference rule for kind ${unknown}`);
    }
  }
}

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
  const claimedBy = new Map<Node, string>();
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
    if (target) {
      const other = claimedBy.get(target);
      if (other) {
        problems.push(`${label}: refers to the same ${entry.kind} (${target.id}) as ${other}`);
        continue;
      }
      claimedBy.set(target, label);
    }
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

  // A rename or create must not leave two live entities sharing a name, nor
  // take a name from an entity this spec deletes: GTM rejects duplicate names
  // and writes run before deletes, so that would fail mid-apply.
  const collided = new Set<string>();
  for (const { label, node } of writes) {
    const key = `${node.kind}\0${normName(node.name)}`;
    const same = liveNamed(node.kind, node.name);
    if (same.length > 1 && !collided.has(key)) {
      collided.add(key);
      problems.push(`${same.length} ${node.kind}s would be named "${node.name}" (ids ${idsOf(same)})`);
    }
    const doomed = nodes.filter((n) => n.deleted && n.kind === node.kind && normName(n.name) === normName(node.name));
    if (doomed.length) {
      problems.push(`${label}: "${node.name}" is held by ${node.kind} ${idsOf(doomed)}, which this spec deletes; ` +
        `delete it first, then reuse the name in a second apply`);
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

  // Pass 4: GTM neither cascades a delete nor rewrites references on a rename,
  // so both are refused while anything surviving the plan still uses the target.
  const survivors = nodes.filter((n) => !n.deleted);
  const usersOf = (target: Node, name: string) => survivors.filter((n) => n !== target && references(n, target, name));
  const used = (user: Node) => `still used by ${user.kind} "${user.name}" (${user.id})`;
  for (const { node } of writes) {
    const oldName = node.stored?.name as string | undefined;
    if (oldName === undefined || oldName === node.name || (node.kind !== "variable" && node.kind !== "tag")) continue;
    // Another entity taking over the old name keeps the references resolving.
    if (survivors.some((n) => n !== node && n.kind === node.kind && n.name === oldName)) continue;
    for (const user of usersOf(node, oldName)) {
      problems.push(`cannot rename ${node.kind} "${oldName}" to "${node.name}": ${used(user)}`);
    }
  }
  for (const { node } of deletes) {
    const name = node.stored!.name as string;
    for (const user of usersOf(node, name)) problems.push(`cannot delete ${node.kind} "${name}": ${used(user)}`);
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
