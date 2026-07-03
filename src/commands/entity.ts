import type { Cmd } from "../command.ts";
import { resolveAlias, openPulled } from "./_shared.ts";
import { findEntityByName, findEntitiesByName, tagFiringTriggers, tagsFiringOnTrigger } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium show <name> [--kind tag|trigger|variable]  → the entity's full raw JSON (parameters included)
export const cmdShow: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium show <name> [--kind tag|trigger|variable]");
  const db = await openPulled(await resolveAlias(flags));

  const kind = flags.kind ? String(flags.kind) : undefined;
  if (!kind) {
    const matches = findEntitiesByName(db, name);
    if (matches.length === 0) throw new Error(`No entity named '${name}'`);
    if (matches.length > 1) {
      const kinds = matches.map((m) => m.kind).join("|");
      throw new Error(`'${name}' matches multiple entities (${kinds}). Disambiguate with --kind <${kinds}>.`);
    }
  }
  const entity = findEntityByName(db, kind ?? findEntitiesByName(db, name)[0]!.kind, name);
  if (!entity) throw new Error(kind ? `No ${kind} named '${name}'` : `No entity named '${name}'`);

  const raw = entity.rawJson ? JSON.parse(entity.rawJson) : {};
  console.log(format(raw, { json: true }));
  return 0;
};

// gallium tag <name>  → its firing/blocking triggers
export const cmdTag: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium tag <name>");
  const db = await openPulled(await resolveAlias(flags));
  const tag = findEntityByName(db, "tag", name);
  if (!tag) throw new Error(`No tag named '${name}'`);
  const rows = tagFiringTriggers(db, tag.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "id"] }));
  return 0;
};

// gallium trigger <name> [--refs]  → tags that fire on it
export const cmdTrigger: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium trigger <name> [--refs]");
  const db = await openPulled(await resolveAlias(flags));
  const trig = findEntityByName(db, "trigger", name);
  if (!trig) throw new Error(`No trigger named '${name}'`);
  const rows = tagsFiringOnTrigger(db, trig.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "tag_id"] }));
  return 0;
};
