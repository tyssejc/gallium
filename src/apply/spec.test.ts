import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec, type SpecEntry } from "./spec.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "gallium-spec-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function writeSpec(content: unknown, rel = "spec.json"): Promise<string> {
  const path = join(dir, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

async function loadError(content: unknown): Promise<string> {
  const path = await writeSpec(content);
  try { await loadSpec(path); } catch (e) { return (e as Error).message; }
  throw new Error("expected loadSpec to reject");
}

test("loads an array of entries", async () => {
  const entries: SpecEntry[] = [
    { kind: "tag", name: "GA4 - Purchase", paused: true },
    { kind: "trigger", name: "Block - GPC Enabled", type: "customEvent" },
  ];
  expect(await loadSpec(await writeSpec(entries))).toEqual(entries);
});

test("replaces valueFile with the file's contents, relative to the spec file, at any parameter depth", async () => {
  await Bun.write(join(dir, "specs", "code", "top.html"), "<script>top</script>");
  await Bun.write(join(dir, "specs", "code", "deep.js"), "function(){ return 1; }");
  const path = await writeSpec([{
    kind: "tag", name: "HTML", type: "html",
    parameter: [
      { type: "template", key: "html", valueFile: "code/top.html" },
      { type: "list", key: "rows", list: [
        { type: "map", map: [{ type: "template", key: "js", valueFile: "code/deep.js" }] },
      ]},
    ],
  }], "specs/spec.json");

  const [entry] = await loadSpec(path);
  expect(entry!.parameter).toEqual([
    { type: "template", key: "html", value: "<script>top</script>" },
    { type: "list", key: "rows", list: [
      { type: "map", map: [{ type: "template", key: "js", value: "function(){ return 1; }" }] },
    ]},
  ]);
});

test("rejects non-JSON, a non-array, an entry without kind or name, an unknown kind", async () => {
  expect(await loadError("[{ not json")).toContain("not valid JSON");
  expect(await loadError({ kind: "tag", name: "A" })).toContain("must be a JSON array");
  const ok = { kind: "tag", name: "A" };
  expect(await loadError([ok, { kind: "tag", name: "B" }, { name: "C" }])).toContain("entry 2: kind");
  expect(await loadError([ok, { kind: "tag", name: "B" }, { kind: "tag" }])).toContain("entry 2: name");
  expect(await loadError([ok, { kind: "tag", name: "B" }, { kind: "tag", name: "  " }])).toContain("entry 2: name");
  expect(await loadError([ok, { kind: "tag", name: "B" }, { kind: "macro", name: "C" }]))
    .toContain('entry 2: kind must be one of tag, trigger, variable, folder (got "macro")');
});

test("rejects trigger-list helpers on anything but a tag", async () => {
  const msg = await loadError([{ kind: "trigger", name: "T", type: "pageview", addFiringTriggers: ["All Pages"] }]);
  expect(msg).toContain("entry 0: addFiringTriggers applies only to a tag");
  expect(await loadError([{ kind: "variable", name: "V", type: "c", blockingTriggers: [] }]))
    .toContain("entry 0: blockingTriggers applies only to a tag");
  // On a tag the same helpers load untouched.
  const entries: SpecEntry[] = [{ kind: "tag", name: "A", addFiringTriggers: ["All Pages"], removeBlockingTriggers: ["X"] }];
  expect(await loadSpec(await writeSpec(entries))).toEqual(entries);
});

test("rejects delete combined with any other field", async () => {
  expect(await loadError([{ kind: "tag", name: "A", delete: true, rename: "B" }]))
    .toContain("entry 0: delete cannot be combined with other fields (rename)");
  expect(await loadError([{ kind: "tag", name: "A", delete: true, paused: true, folder: "F" }]))
    .toContain("entry 0: delete cannot be combined with other fields (paused, folder)");
  const entries: SpecEntry[] = [{ kind: "tag", name: "A", delete: true }];
  expect(await loadSpec(await writeSpec(entries))).toEqual(entries);
});

test("rejects a missing valueFile, naming the path", async () => {
  const msg = await loadError([{ kind: "tag", name: "A", type: "html",
    parameter: [{ type: "template", key: "html", valueFile: "missing.html" }] }]);
  expect(msg).toContain(`entry 0: valueFile not found: ${join(dir, "missing.html")}`);
});

test("rejects two entries for the same kind and name", async () => {
  const msg = await loadError([
    { kind: "tag", name: "GA4 - Purchase", paused: true },
    { kind: "trigger", name: "GA4 - Purchase", type: "pageview" },
    { kind: "tag", name: "  ga4 - purchase ", paused: false },
  ]);
  expect(msg).toContain('entry 2: duplicate of entry 0 (tag "ga4 - purchase")');
  expect(msg).not.toContain("entry 1");
});
