import { test, expect } from "bun:test";
import { parseContainerRef, parseAgainst, describeSnapshot } from "./ref.ts";

test("parseContainerRef: bare alias is a workspace ref", () => {
  expect(parseContainerRef("acme/web")).toEqual({ alias: "acme/web", snapshot: null });
});

test("parseContainerRef: @vN, @live, @latest", () => {
  expect(parseContainerRef("acme/web@v42")).toEqual({ alias: "acme/web", snapshot: { kind: "version", id: "42" } });
  expect(parseContainerRef("acme/web@live")).toEqual({ alias: "acme/web", snapshot: { kind: "live" } });
  expect(parseContainerRef("acme/web@latest")).toEqual({ alias: "acme/web", snapshot: { kind: "latest" } });
});

test("parseContainerRef: rejects malformed suffixes", () => {
  expect(() => parseContainerRef("acme/web@")).toThrow(/Valid forms/);
  expect(() => parseContainerRef("acme/web@v")).toThrow(/Valid forms/);
  expect(() => parseContainerRef("acme/web@nope")).toThrow(/Valid forms/);
  expect(() => parseContainerRef("@v42")).toThrow(/no alias/);
  expect(() => parseContainerRef("")).toThrow(/[Ee]mpty/);
});

test("parseContainerRef: @v0 is rejected because the API treats 0 as 'latest'", () => {
  expect(() => parseContainerRef("acme/web@v0")).toThrow(/@latest/);
});

test("parseContainerRef: rejects env: on the -c side", () => {
  expect(() => parseContainerRef("acme/web@env:dev")).toThrow(/--against/);
});

test("parseAgainst: all four target forms", () => {
  expect(parseAgainst("42")).toEqual({ kind: "version", id: "42" });
  expect(parseAgainst("env:dev")).toEqual({ kind: "env", name: "dev" });
  expect(parseAgainst("env:My Env")).toEqual({ kind: "env", name: "My Env" });
  expect(parseAgainst("live")).toEqual({ kind: "live" });
  expect(parseAgainst("latest")).toEqual({ kind: "latest" });
});

test("parseAgainst: rejects junk, empty env name, and version 0", () => {
  expect(() => parseAgainst("v42")).toThrow(/Valid forms/);
  expect(() => parseAgainst("env:")).toThrow(/environment name/);
  expect(() => parseAgainst("0")).toThrow(/latest/);
});

test("describeSnapshot produces readable phrases", () => {
  expect(describeSnapshot({ kind: "version", id: "42" })).toBe("version 42");
  expect(describeSnapshot({ kind: "live" })).toBe("the live version");
  expect(describeSnapshot({ kind: "latest" })).toBe("the latest version");
  expect(describeSnapshot({ kind: "env", name: "Dev" })).toBe("environment 'Dev'");
});
