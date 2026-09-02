import { test, expect } from "bun:test";
import { contentHash, normalizeForHash, STRIP_KEYS } from "./hash.ts";

test("stripped keys are removed at the top level", () => {
  const ws = { tagId: "10", name: "GA4", path: "accounts/1/containers/2/workspaces/3/tags/10",
    fingerprint: "111", workspaceId: "3", accountId: "1", containerId: "2" };
  const ver = { tagId: "10", name: "GA4", path: "accounts/1/containers/2/versions/42/tags/10",
    fingerprint: "999", containerVersionId: "42", accountId: "1", containerId: "2" };
  expect(contentHash(ws)).toBe(contentHash(ver));
});

test("stripped keys are removed inside nested objects and arrays", () => {
  const a = { tagId: "10", parameter: [{ key: "id", value: "X", fingerprint: "aaa" }] };
  const b = { tagId: "10", parameter: [{ key: "id", value: "X", fingerprint: "bbb" }] };
  expect(contentHash(a)).toBe(contentHash(b));
});

test("key order does not affect the hash", () => {
  expect(contentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHash({ b: { d: 3, c: 2 }, a: 1 }));
});

test("a change in any non-stripped field changes the hash", () => {
  const base = { tagId: "10", name: "GA4", paused: false };
  expect(contentHash({ ...base, name: "GA4 v2" })).not.toBe(contentHash(base));
  expect(contentHash({ ...base, paused: true })).not.toBe(contentHash(base));
  // An unmodeled field gallium knows nothing about still counts as content.
  expect(contentHash({ ...base, someFutureField: "x" })).not.toBe(contentHash(base));
});

test("array order is significant", () => {
  expect(contentHash({ firingTriggerId: ["1", "2"] })).not.toBe(contentHash({ firingTriggerId: ["2", "1"] }));
});

test("normalizeForHash drops every documented STRIP key", () => {
  const input: Record<string, unknown> = { keep: 1 };
  for (const k of STRIP_KEYS) input[k] = "drop me";
  expect(normalizeForHash(input)).toEqual({ keep: 1 });
});

test("contentHash returns 64-char lowercase hex", () => {
  expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
});
