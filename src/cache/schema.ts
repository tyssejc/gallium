export const SCHEMA_VERSION = 2;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- One row per entity in the working workspace.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT NOT NULL,                  -- numeric GTM id (tagId/triggerId/variableId/folderId) or builtin type
  kind TEXT NOT NULL,                -- tag | trigger | variable | builtin_variable | folder | template
  name TEXT NOT NULL,
  type TEXT,                         -- GTM type string (e.g. html, jsm, gaawe)
  paused INTEGER NOT NULL DEFAULT 0,
  parent_folder_id TEXT,
  raw_json TEXT,                     -- full entity JSON
  search_text TEXT,                  -- name + parameter values + code, lowercased
  content_hash TEXT NOT NULL DEFAULT '',   -- sha256 of raw_json minus location fields
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

-- A references B: source entity references a variable by {{name}}.
CREATE TABLE IF NOT EXISTS variable_refs (
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
  variable_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_varrefs_name ON variable_refs(variable_name);

-- Tag fires on trigger (firing|blocking).
CREATE TABLE IF NOT EXISTS tag_triggers (
  tag_id TEXT NOT NULL, trigger_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'firing'   -- firing | blocking
);
CREATE INDEX IF NOT EXISTS idx_tagtrig_tag ON tag_triggers(tag_id);
CREATE INDEX IF NOT EXISTS idx_tagtrig_trig ON tag_triggers(trigger_id);

-- Workspace pending changes, from getStatus.
CREATE TABLE IF NOT EXISTS changes (
  kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT, change_status TEXT NOT NULL
);
`;
