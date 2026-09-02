import { test, expect } from "bun:test";
import { environmentRows, versionRows, fingerprintToIso, attachDates } from "./versionInfo.ts";

test("environmentRows joins each environment to the name of the version it points at", () => {
  const rows = environmentRows(
    [
      { environmentId: "1", name: "Live", type: "live", containerVersionId: "42" },
      { environmentId: "3", name: "Dev", type: "user", containerVersionId: "41" },
    ],
    [
      { containerVersionId: "42", name: "go-live" },
      { containerVersionId: "41", name: "category pixels" },
    ],
  );
  expect(rows).toEqual([
    { name: "Live", type: "live", environment_id: "1", version_id: "42", version_name: "go-live" },
    { name: "Dev", type: "user", environment_id: "3", version_id: "41", version_name: "category pixels" },
  ]);
});

test("environmentRows renders an unpinned environment as tracking the newest publish", () => {
  const [row] = environmentRows(
    [{ environmentId: "2", name: "Latest", type: "latest", containerVersionId: "0" }], []);
  expect(row!.version_id).toBe("latest");
  expect(row!.version_name).toBe("(tracks newest publish)");
});

test("environmentRows tolerates a missing containerVersionId and an unknown version id", () => {
  const rows = environmentRows(
    [
      { environmentId: "4", name: "NoVersion", type: "user" },
      { environmentId: "5", name: "Unknown", type: "user", containerVersionId: "99" },
    ], []);
  expect(rows[0]!.version_id).toBe("latest");
  expect(rows[1]!.version_id).toBe("99");
  expect(rows[1]!.version_name).toBe("");
});

test("versionRows sorts newest-first by numeric id and applies the limit", () => {
  const headers = [
    { containerVersionId: "9", name: "nine" },
    { containerVersionId: "10", name: "ten" },
    { containerVersionId: "41", name: "forty-one", numTags: "7", numTriggers: "3", numVariables: "5", deleted: true },
  ];
  expect(versionRows(headers, 2).map((r) => r.version_id)).toEqual(["41", "10"]);
  expect(versionRows(headers, 2)[0]).toEqual({
    version_id: "41", name: "forty-one", deleted: true,
    num_tags: "7", num_triggers: "3", num_variables: "5",
  });
  expect(versionRows(headers, 99).map((r) => r.version_id)).toEqual(["41", "10", "9"]);
});

test("versionRows fills missing optional header fields with empty strings", () => {
  expect(versionRows([{ containerVersionId: "1" }], 10)[0]).toEqual({
    version_id: "1", name: "", deleted: false, num_tags: "", num_triggers: "", num_variables: "",
  });
});

test("fingerprintToIso decodes GTM's epoch-millis fingerprint", () => {
  expect(fingerprintToIso("1787666891824")).toBe("2026-08-25T14:08:11.824Z");
});

test("fingerprintToIso yields empty string for anything unusable", () => {
  for (const bad of [undefined, "", "0", "not-a-number", "-5"]) {
    expect(fingerprintToIso(bad)).toBe("");
  }
});

test("attachDates adds created_at per version id, blank where unknown", () => {
  const rows = versionRows([{ containerVersionId: "42" }, { containerVersionId: "41" }], 10);
  const dated = attachDates(rows, new Map([["42", "1787666891824"]]));
  expect(dated[0]).toMatchObject({ version_id: "42", created_at: "2026-08-25T14:08:11.824Z" });
  expect(dated[1]).toMatchObject({ version_id: "41", created_at: "" });
});
