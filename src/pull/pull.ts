import type { Database } from "bun:sqlite";
import type { GtmClient } from "../gtm/client.ts";
import type {
  GtmParameter, GtmTag, GtmTrigger, GtmVariable,
  GtmBuiltInVariable, GtmFolder, GtmTemplate, GtmContainerVersion,
} from "../gtm/types.ts";
import {
  resetDerived, upsertEntity, recordVariableRef, recordTagTrigger, recordChange, setMeta, countEntities,
} from "../cache/repo.ts";
import { collectParameterStrings, extractVariableRefs, buildSearchText } from "./classify.ts";

function conditionStrings(conds?: Array<{ parameter?: GtmParameter[] }>): string[] {
  return (conds ?? []).flatMap((c) => collectParameterStrings(c.parameter));
}

function recordRefs(db: Database, kind: string, id: string, strings: string[]): void {
  for (const ref of extractVariableRefs(strings)) recordVariableRef(db, kind, id, ref);
}

export interface EntitySnapshot {
  tag?: GtmTag[]; trigger?: GtmTrigger[]; variable?: GtmVariable[];
  builtInVariable?: GtmBuiltInVariable[]; folder?: GtmFolder[]; customTemplate?: GtmTemplate[];
}

// Pure ingest — no client. Workspaces and version snapshots deliver the same
// entity arrays, so both funnel through here.
export function ingestEntities(db: Database, snap: EntitySnapshot): void {
  for (const t of snap.tag ?? []) {
    const strings = collectParameterStrings(t.parameter);
    upsertEntity(db, { id: t.tagId, kind: "tag", name: t.name, type: t.type, paused: !!t.paused,
      parentFolderId: t.parentFolderId ?? null, rawJson: JSON.stringify(t), searchText: buildSearchText(t.name, strings) });
    recordRefs(db, "tag", t.tagId, strings);
    for (const trig of t.firingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "firing");
    for (const trig of t.blockingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "blocking");
  }

  for (const tr of snap.trigger ?? []) {
    const strings = [
      ...collectParameterStrings(tr.parameter),
      ...conditionStrings(tr.filter),
      ...conditionStrings(tr.customEventFilter),
      ...conditionStrings(tr.autoEventFilter),
    ];
    upsertEntity(db, { id: tr.triggerId, kind: "trigger", name: tr.name, type: tr.type, paused: false,
      parentFolderId: tr.parentFolderId ?? null, rawJson: JSON.stringify(tr), searchText: buildSearchText(tr.name, strings) });
    recordRefs(db, "trigger", tr.triggerId, strings);
  }

  for (const v of snap.variable ?? []) {
    const strings = collectParameterStrings(v.parameter);
    upsertEntity(db, { id: v.variableId, kind: "variable", name: v.name, type: v.type, paused: false,
      parentFolderId: v.parentFolderId ?? null, rawJson: JSON.stringify(v), searchText: buildSearchText(v.name, strings) });
    recordRefs(db, "variable", v.variableId, strings);
  }

  for (const b of snap.builtInVariable ?? []) {
    upsertEntity(db, { id: b.type, kind: "builtin_variable", name: b.name, type: b.type, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(b), searchText: buildSearchText(b.name, []) });
  }
  for (const f of snap.folder ?? []) {
    upsertEntity(db, { id: f.folderId, kind: "folder", name: f.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(f), searchText: buildSearchText(f.name, []) });
  }
  for (const tpl of snap.customTemplate ?? []) {
    const code = tpl.templateData ?? "";
    upsertEntity(db, { id: tpl.templateId, kind: "template", name: tpl.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(tpl), searchText: buildSearchText(tpl.name, [code]) });
  }
}

export async function pullWorkspace(db: Database, client: GtmClient, ws: string, nowIso: string): Promise<void> {
  resetDerived(db);
  // Workspaces expose custom templates via a separate list call; versions inline
  // them as `customTemplate`. Normalized here so ingest sees one shape.
  ingestEntities(db, {
    tag: await client.listTags(ws),
    trigger: await client.listTriggers(ws),
    variable: await client.listVariables(ws),
    builtInVariable: await client.listBuiltInVariables(ws),
    folder: await client.listFolders(ws),
    customTemplate: await client.listTemplates(ws),
  });

  // GTM answers a list call on a non-existent workspace with an empty array
  // rather than a 404, so an empty ingest is indistinguishable from a healthy
  // pull of an empty container. Recording it would leave every later question
  // answering "no results" from an empty cache — a silent wrong answer, which
  // is far worse than a false alarm on a genuinely empty container.
  if (countEntities(db) === 0) {
    const m = ws.match(/^accounts\/([^/]+)\/containers\/([^/]+)\/workspaces\/(.+)$/);
    const check = m ? `\n  gallium workspaces ${m[1]} ${m[2]}` : "";
    throw new Error(
      `Workspace ${m?.[3] ?? ws} returned no entities; nothing was cached. ` +
      `The configured workspace_id is probably stale or deleted — list the real ones with:${check}\n` +
      `(If this container really is empty, there is nothing to pull.)`,
    );
  }

  const status = await client.getStatus(ws);
  for (const ch of status.workspaceChange ?? []) {
    const e = ch.tag ?? ch.trigger ?? ch.variable ?? ch.folder ?? ch.builtInVariable ?? ch.customTemplate;
    if (!e) continue;
    const kind = ch.tag ? "tag"
      : ch.trigger ? "trigger"
      : ch.variable ? "variable"
      : ch.folder ? "folder"
      : ch.builtInVariable ? "builtin_variable"
      : "template";
    const id = (ch.tag?.tagId ?? ch.trigger?.triggerId ?? ch.variable?.variableId
      ?? ch.folder?.folderId ?? ch.builtInVariable?.type ?? ch.customTemplate?.templateId) as string;
    recordChange(db, kind, id, (e as any).name ?? "", ch.changeStatus);
  }

  setMeta(db, "source", "workspace");
  setMeta(db, "last_pulled_at", nowIso);
}

// Version snapshots are immutable: one GET, ingest, done. No status call —
// a version has no pending changes.
export async function pullVersion(
  db: Database, client: GtmClient, accountId: string, containerId: string,
  versionId: string, nowIso: string,
): Promise<GtmContainerVersion> {
  const version = await client.getVersion(accountId, containerId, versionId);
  resetDerived(db);
  ingestEntities(db, version);
  setMeta(db, "source", "version");
  setMeta(db, "version_id", version.containerVersionId ?? versionId);
  setMeta(db, "version_name", version.name ?? "");
  setMeta(db, "version_description", version.description ?? "");
  setMeta(db, "version_fingerprint", version.fingerprint ?? "");
  setMeta(db, "last_pulled_at", nowIso);
  return version;
}
