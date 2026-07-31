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

test("environments and versions are registered commands", async () => {
  const orig = console.log; let out = "";
  console.log = (s: string) => { out = s; };
  try { await run(["--help"]); } finally { console.log = orig; }
  expect(out).toContain("environments");
  expect(out).toContain("versions");
});
