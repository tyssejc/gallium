import type { Cmd } from "../command.ts";
import { openTarget, deprecated } from "./_shared.ts";
import { findEntityByName, findEntitiesByName, tagFiringTriggers, tagsFiringOnTrigger } from "../cache/repo.ts";
import { format } from "../output.ts";

// gallium <tags|triggers|variables|folders> get <name>  → the entity's full raw
// JSON. The noun carries the kind, so this can never be ambiguous — the
// disambiguation that `--kind` existed for is structural here.
export function getFor(kind: string): Cmd {
  return async (positionals, flags) => {
    const name = positionals.join(" ").trim();
    if (!name) throw new Error(`usage: gallium ${kind}s get <name>`);
    const db = await openTarget(flags);
    const entity = findEntityByName(db, kind, name);
    if (!entity) throw new Error(`No ${kind} named '${name}'`);
    console.log(format(entity.rawJson ? JSON.parse(entity.rawJson) : {}, { json: true }));
    return 0;
  };
}

// gallium tags triggers <name>  → its firing/blocking triggers
export const cmdTagsTriggers: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium tags triggers <name>");
  const db = await openTarget(flags);
  const tag = findEntityByName(db, "tag", name);
  if (!tag) throw new Error(`No tag named '${name}'`);
  const rows = tagFiringTriggers(db, tag.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "id"] }));
  return 0;
};

// gallium triggers tags <name>  → tags that fire on it
export const cmdTriggersTags: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium triggers tags <name>");
  const db = await openTarget(flags);
  const trig = findEntityByName(db, "trigger", name);
  if (!trig) throw new Error(`No trigger named '${name}'`);
  const rows = tagsFiringOnTrigger(db, trig.id);
  console.log(format(rows, { json: !!flags.json, columns: ["relation", "name", "tag_id"] }));
  return 0;
};

// Deprecated: gallium show <name> [--kind tag|trigger|variable]
// Kept cross-kind, including the ambiguity error, since the noun form is the
// thing that replaces `--kind`.
export const cmdShow: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium show <name> [--kind tag|trigger|variable]");
  const db = await openTarget(flags);

  const explicit = flags.kind ? String(flags.kind) : undefined;
  let kind = explicit;
  if (!kind) {
    const matches = findEntitiesByName(db, name);
    if (matches.length === 0) throw new Error(`No entity named '${name}'`);
    if (matches.length > 1) {
      const kinds = matches.map((m) => m.kind);
      throw new Error(
        `'${name}' matches multiple entities (${kinds.join("|")}). ` +
        `Disambiguate with the noun: ${kinds.map((k) => `gallium ${k}s get '${name}'`).join(", ")}.`,
      );
    }
    kind = matches[0]!.kind;
  }
  deprecated(`gallium show '${name}'`, `gallium ${kind}s get '${name}'`);
  return getFor(kind)(positionals, flags);
};

// Deprecated: gallium tag <name>
export const cmdTag: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium tag <name>");
  deprecated(`gallium tag '${name}'`, `gallium tags triggers '${name}'`);
  return cmdTagsTriggers(positionals, flags);
};

// Deprecated: gallium trigger <name>
export const cmdTrigger: Cmd = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) throw new Error("usage: gallium trigger <name>");
  deprecated(`gallium trigger '${name}'`, `gallium triggers tags '${name}'`);
  return cmdTriggersTags(positionals, flags);
};
