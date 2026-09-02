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
  expect(out).toContain("versions: list, show");
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
