import { test, expect } from "bun:test";
import { resolveSnapshotVersionId } from "./_snapshot.ts";

const client = {
  getLiveVersion: async () => ({ containerVersionId: "42" }),
  getLatestVersionHeader: async () => ({ containerVersionId: "43" }),
  listEnvironments: async () => [
    { environmentId: "1", name: "Live", type: "live", containerVersionId: "42" },
    { environmentId: "3", name: "Dev", type: "user", containerVersionId: "41" },
    { environmentId: "2", name: "Latest", type: "latest", containerVersionId: "0" },
  ],
} as any;

test("an explicit version id resolves to itself without any API call", async () => {
  const exploding = { getLiveVersion: () => { throw new Error("should not be called"); } } as any;
  expect(await resolveSnapshotVersionId(exploding, "1", "2", { kind: "version", id: "42" })).toBe("42");
});

test("live and latest resolve via their dedicated endpoints", async () => {
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "live" })).toBe("42");
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "latest" })).toBe("43");
});

test("env resolves by case-insensitive name to the version it points at", async () => {
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "dev" })).toBe("41");
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "Dev" })).toBe("41");
});

test("an unpinned env falls through to the latest version", async () => {
  expect(await resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "Latest" })).toBe("43");
});

test("an unknown env name errors and lists what is available", async () => {
  await expect(resolveSnapshotVersionId(client, "1", "2", { kind: "env", name: "staging" }))
    .rejects.toThrow(/Live, Dev, Latest/);
});

test("a container with no published version gives an actionable error", async () => {
  const empty = { getLiveVersion: async () => ({}), getLatestVersionHeader: async () => ({}) } as any;
  await expect(resolveSnapshotVersionId(empty, "1", "2", { kind: "live" })).rejects.toThrow(/no live/i);
  await expect(resolveSnapshotVersionId(empty, "1", "2", { kind: "latest" })).rejects.toThrow(/no versions/i);
});
