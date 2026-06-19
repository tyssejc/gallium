import { test, expect } from "bun:test";
import { format } from "./output.ts";

test("format renders JSON when json:true", () => {
  expect(format([{ a: 1 }], { json: true })).toBe(JSON.stringify([{ a: 1 }], null, 2));
});

test("format renders TSV with chosen columns", () => {
  const out = format([{ name: "X", id: "1" }], { json: false, columns: ["name", "id"] });
  expect(out).toBe("name\tid\nX\t1");
});

test("format returns (no results) for empty arrays in TSV mode", () => {
  expect(format([], { json: false })).toBe("(no results)");
});
