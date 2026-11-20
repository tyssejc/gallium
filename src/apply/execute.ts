import type { GtmClient } from "../gtm/client.ts";
import { ID_FIELD, newRef, type Op } from "./plan.ts";

export interface ExecResult { applied: Op[]; failed?: { op: Op; error: string }; pending: Op[]; }

// Replaces every `@new:…` placeholder string, at any depth, with the id GTM
// returned for that create. A placeholder with no earlier create is a bug in
// the plan's ordering, so it fails the op rather than being sent.
function substitute(value: unknown, created: Map<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("@new:")) {
    const id = created.get(value);
    if (id === undefined) throw new Error(`unresolved placeholder ${value}`);
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, created));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, created)]));
  }
  return value;
}

// Sends the plan's writes in order. GTM has no multi-entity transaction, so the
// first failure stops the run; `applied` and `pending` say what did and did not land.
export async function executePlan(ops: Op[], client: GtmClient, ws: string): Promise<ExecResult> {
  const writes = ops.filter((op) => op.action !== "unchanged");
  const created = new Map<string, string>();
  const applied: Op[] = [];
  for (const [i, op] of writes.entries()) {
    try {
      const body = op.body && (substitute(op.body, created) as Record<string, unknown>);
      if (op.action === "create") {
        const res = await client.createEntity(ws, op.kind, body!);
        const id = res?.[ID_FIELD[op.kind]];
        // Without an id, later bodies would reference "undefined"; stop here instead.
        if (typeof id !== "string" || !id) throw new Error(`create ${op.kind} "${op.name}" returned no ${ID_FIELD[op.kind]}`);
        created.set(newRef(op.kind, op.name), id);
        applied.push({ ...op, id, body });
      } else if (op.action === "update") {
        await client.updateEntity(ws, op.kind, op.id!, body!, op.fingerprint);
        applied.push({ ...op, body });
      } else {
        await client.deleteEntity(ws, op.kind, op.id!);
        applied.push(op);
      }
    } catch (e) {
      return { applied, failed: { op, error: e instanceof Error ? e.message : String(e) }, pending: writes.slice(i + 1) };
    }
  }
  return { applied, pending: [] };
}
