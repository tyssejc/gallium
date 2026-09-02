import { test, expect } from "bun:test";
import { run } from "./cli.ts";

test("--version prints and returns 0", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { expect(await run(["--version"])).toBe(0); expect(out).toMatch(/^\d+\.\d+\.\d+/); }
  finally { console.log = orig; }
});

test("unknown noun returns 1", async () => {
  const orig = console.error; console.error = () => {};
  try { expect(await run(["bogus"])).toBe(1); } finally { console.error = orig; }
});

test("environments and versions are noun groups, not flat commands", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { await run(["--help"]); } finally { console.log = orig; }
  expect(out).toContain("environments: list");
  expect(out).toContain("versions: list, get");
});

test("the flat 'version' command is gone in favour of 'versions show'", async () => {
  const orig = console.error; console.error = () => {};
  try { expect(await run(["version", "42"])).toBe(1); } finally { console.error = orig; }
});

test("an unknown verb under a noun group returns 1", async () => {
  const orig = console.error; console.error = () => {};
  try { expect(await run(["versions", "bogus"])).toBe(1); } finally { console.error = orig; }
});

test("--version prints the CLI version", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { expect(await run(["--version"])).toBe(0); } finally { console.log = orig; }
  expect(out).toMatch(/^\d+\.\d+\.\d+/);
});

function helpLines(out: string): { flat: string; groups: string } {
  const lines = out.split("\n");
  const flat = lines.find((l) => l.trim().startsWith("login")) ?? "";
  return { flat, groups: lines.filter((l) => l.includes(":")).join("\n") };
}

async function help(): Promise<string> {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { await run(["--help"]); } finally { console.log = orig; }
  return out;
}

test("entity nouns are groups carrying list, get, and their relation verbs", async () => {
  const { groups } = helpLines(await help());
  expect(groups).toContain("tags: list, get, triggers");
  expect(groups).toContain("triggers: list, get, tags");
  expect(groups).toContain("variables: list, get, refs");
  expect(groups).toContain("folders: list, get");
  expect(groups).toContain("versions: list, get");
});

test("deprecated spellings are hidden from --help", async () => {
  const { flat, groups } = helpLines(await help());
  for (const gone of ["list", "tag", "trigger", "refs", "show"]) {
    expect(flat).not.toContain(gone);
  }
  expect(flat).toContain("login");
  expect(flat).toContain("diff");
  // `versions show` is deprecated too; `container show` is config, and stays.
  expect(groups).not.toContain("versions: list, get, show");
});

test("deprecated spellings still route", async () => {
  const origErr = console.error; console.error = () => {};
  try {
    expect(await run(["list", "bogus-kind"]).catch(() => 1)).toBe(1);
  } finally { console.error = origErr; }
});

test("an unknown verb under an entity group returns 1", async () => {
  const orig = console.error; console.error = () => {};
  try { expect(await run(["tags", "bogus"])).toBe(1); } finally { console.error = orig; }
});
