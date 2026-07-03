import type { Database } from "bun:sqlite";

export interface EntityRow {
  id: string; kind: string; name: string; type: string | null;
  paused: boolean; parentFolderId: string | null; rawJson: string | null; searchText: string;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function getMeta(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
}

export function resetDerived(db: Database): void {
  for (const t of ["entities", "variable_refs", "tag_triggers", "changes"]) db.exec(`DELETE FROM ${t};`);
}

export function upsertEntity(db: Database, r: EntityRow): void {
  db.query(`INSERT INTO entities (id,kind,name,type,paused,parent_folder_id,raw_json,search_text)
    VALUES ($id,$kind,$name,$type,$paused,$folder,$raw,$search)
    ON CONFLICT(kind,id) DO UPDATE SET name=$name,type=$type,paused=$paused,
      parent_folder_id=$folder,raw_json=$raw,search_text=$search`).run({
    $id: r.id, $kind: r.kind, $name: r.name, $type: r.type, $paused: r.paused ? 1 : 0,
    $folder: r.parentFolderId, $raw: r.rawJson, $search: r.searchText,
  });
}

export function recordVariableRef(db: Database, sourceKind: string, sourceId: string, variableName: string): void {
  db.query("INSERT INTO variable_refs (source_kind,source_id,variable_name) VALUES (?,?,?)").run(sourceKind, sourceId, variableName);
}
export function recordTagTrigger(db: Database, tagId: string, triggerId: string, relation: string): void {
  db.query("INSERT INTO tag_triggers (tag_id,trigger_id,relation) VALUES (?,?,?)").run(tagId, triggerId, relation);
}
export function recordChange(db: Database, kind: string, id: string, name: string, changeStatus: string): void {
  db.query("INSERT INTO changes (kind,id,name,change_status) VALUES (?,?,?,?)").run(kind, id, name, changeStatus);
}

export function refsToVariable(db: Database, name: string): { kind: string; id: string; name: string }[] {
  return db.query(`SELECT e.kind AS kind, e.id AS id, e.name AS name
    FROM variable_refs vr JOIN entities e ON e.kind=vr.source_kind AND e.id=vr.source_id
    WHERE vr.variable_name=? ORDER BY e.kind, e.name`).all(name) as any;
}
export function tagFiringTriggers(db: Database, tagId: string): { id: string; name: string; relation: string }[] {
  return db.query(`SELECT tt.trigger_id AS id, e.name AS name, tt.relation AS relation
    FROM tag_triggers tt JOIN entities e ON e.kind='trigger' AND e.id=tt.trigger_id
    WHERE tt.tag_id=? ORDER BY tt.relation, e.name`).all(tagId) as any;
}
export function tagsFiringOnTrigger(db: Database, triggerId: string): { tag_id: string; name: string; relation: string }[] {
  return db.query(`SELECT tt.tag_id AS tag_id, e.name AS name, tt.relation AS relation
    FROM tag_triggers tt JOIN entities e ON e.kind='tag' AND e.id=tt.tag_id
    WHERE tt.trigger_id=? ORDER BY tt.relation, e.name`).all(triggerId) as any;
}

export function grepCode(db: Database, pattern: string): { kind: string; id: string; name: string }[] {
  const escaped = pattern.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.query(`SELECT kind,id,name FROM entities WHERE search_text LIKE ? ESCAPE '\\' ORDER BY kind,name`)
    .all(`%${escaped}%`) as any;
}

export function listEntities(
  db: Database, kind: string, opts: { type?: string; folderId?: string; pausedOnly?: boolean } = {},
): EntityRow[] {
  const where = ["kind=$kind"]; const params: Record<string, unknown> = { $kind: kind };
  if (opts.type) { where.push("type=$type"); params.$type = opts.type; }
  if (opts.folderId) { where.push("parent_folder_id=$folder"); params.$folder = opts.folderId; }
  if (opts.pausedOnly) where.push("paused=1");
  const rows = db.query(`SELECT id,kind,name,type,paused,parent_folder_id AS parentFolderId,
    raw_json AS rawJson, search_text AS searchText FROM entities WHERE ${where.join(" AND ")} ORDER BY name`).all(params) as any[];
  return rows.map((r) => ({ ...r, paused: !!r.paused }));
}

export function unusedVariables(db: Database): { id: string; name: string }[] {
  return db.query(`SELECT id,name FROM entities WHERE kind='variable'
    AND name NOT IN (SELECT variable_name FROM variable_refs) ORDER BY name`).all() as any;
}

export function pendingChanges(db: Database, opts: { status?: string } = {}): { kind: string; id: string; name: string; change_status: string }[] {
  if (opts.status) {
    return db.query("SELECT kind,id,name,change_status FROM changes WHERE change_status=? ORDER BY kind,name").all(opts.status) as any;
  }
  return db.query("SELECT kind,id,name,change_status FROM changes ORDER BY kind,name").all() as any;
}

export function findEntityByName(db: Database, kind: string, name: string): EntityRow | null {
  const r = db.query(`SELECT id,kind,name,type,paused,parent_folder_id AS parentFolderId,
    raw_json AS rawJson, search_text AS searchText FROM entities
    WHERE kind=? AND lower(name)=lower(?) LIMIT 1`).get(kind, name) as any;
  return r ? { ...r, paused: !!r.paused } : null;
}

export function findEntitiesByName(db: Database, name: string): { kind: string; id: string; name: string }[] {
  return db.query(`SELECT kind,id,name FROM entities WHERE lower(name)=lower(?) ORDER BY kind`).all(name) as any;
}
