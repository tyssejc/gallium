import type { Database } from "bun:sqlite";
import type { GtmClient } from "../gtm/client.ts";
import type { GtmTag, GtmTrigger, GtmVariable } from "../gtm/types.ts";
import {
  resetDerived, upsertEntity, recordVariableRef, recordTagTrigger, recordChange, setMeta,
} from "../cache/repo.ts";
import { collectParameterStrings, extractVariableRefs, buildSearchText } from "./classify.ts";

function recordRefs(db: Database, kind: string, id: string, strings: string[]): void {
  for (const ref of extractVariableRefs(strings)) recordVariableRef(db, kind, id, ref);
}

export async function pullContainer(db: Database, client: GtmClient, ws: string, nowIso: string): Promise<void> {
  resetDerived(db);

  for (const t of (await client.listTags(ws)) as GtmTag[]) {
    const strings = collectParameterStrings(t.parameter);
    upsertEntity(db, { id: t.tagId, kind: "tag", name: t.name, type: t.type, paused: !!t.paused,
      parentFolderId: t.parentFolderId ?? null, rawJson: JSON.stringify(t), searchText: buildSearchText(t.name, strings) });
    recordRefs(db, "tag", t.tagId, strings);
    for (const trig of t.firingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "firing");
    for (const trig of t.blockingTriggerId ?? []) recordTagTrigger(db, t.tagId, trig, "blocking");
  }

  for (const tr of (await client.listTriggers(ws)) as GtmTrigger[]) {
    const strings = [...collectParameterStrings(tr.parameter), ...collectParameterStrings(tr.filter),
      ...collectParameterStrings(tr.customEventFilter)];
    upsertEntity(db, { id: tr.triggerId, kind: "trigger", name: tr.name, type: tr.type, paused: false,
      parentFolderId: tr.parentFolderId ?? null, rawJson: JSON.stringify(tr), searchText: buildSearchText(tr.name, strings) });
    recordRefs(db, "trigger", tr.triggerId, strings);
  }

  for (const v of (await client.listVariables(ws)) as GtmVariable[]) {
    const strings = collectParameterStrings(v.parameter);
    upsertEntity(db, { id: v.variableId, kind: "variable", name: v.name, type: v.type, paused: false,
      parentFolderId: v.parentFolderId ?? null, rawJson: JSON.stringify(v), searchText: buildSearchText(v.name, strings) });
    recordRefs(db, "variable", v.variableId, strings);
  }

  for (const b of await client.listBuiltInVariables(ws)) {
    upsertEntity(db, { id: b.type, kind: "builtin_variable", name: b.name, type: b.type, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(b), searchText: buildSearchText(b.name, []) });
  }
  for (const f of await client.listFolders(ws)) {
    upsertEntity(db, { id: f.folderId, kind: "folder", name: f.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(f), searchText: buildSearchText(f.name, []) });
  }
  for (const tpl of await client.listTemplates(ws)) {
    const code = tpl.templateData ?? "";
    upsertEntity(db, { id: tpl.templateId, kind: "template", name: tpl.name, type: null, paused: false,
      parentFolderId: null, rawJson: JSON.stringify(tpl), searchText: buildSearchText(tpl.name, [code]) });
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

  setMeta(db, "last_pulled_at", nowIso);
}
