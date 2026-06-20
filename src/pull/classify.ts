import type { GtmParameter } from "../gtm/types.ts";

export function collectParameterStrings(params?: GtmParameter[]): string[] {
  const out: string[] = [];
  for (const p of params ?? []) {
    if (typeof p.value === "string") out.push(p.value);
    if (p.list) out.push(...collectParameterStrings(p.list));
    if (p.map) out.push(...collectParameterStrings(p.map));
  }
  return out;
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractVariableRefs(strings: string[]): string[] {
  const found = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(VAR_RE)) {
      const name = m[1]?.trim();
      if (name) found.add(name);
    }
  }
  return [...found];
}

export function buildSearchText(name: string, strings: string[]): string {
  return [name, ...strings].join("\n").toLowerCase();
}
