import { test, expect } from "bun:test";
import { parseConfig, resolveContainer } from "./config.ts";

const TOML = `
[oauth]
client_id = "cid"
client_secret = "\${env:GALLIUM_SECRET}"

[service_account]
key_file = "/keys/sa.json"

[containers."acme/web"]
account_id = "111"
container_id = "222"
workspace_id = "3"
`;

test("parseConfig reads [oauth] block and substitutes env in client_secret", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "mysecret" });
  expect(cfg.oauth).toEqual({ client_id: "cid", client_secret: "mysecret" });
});

test("parseConfig reads [service_account] key_file", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "mysecret" });
  expect(cfg.serviceAccount).toEqual({ key_file: "/keys/sa.json" });
});

test("parseConfig reads containers with string-coerced ids and no account field", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "mysecret" });
  expect(cfg.containers["acme/web"]).toEqual({ account_id: "111", container_id: "222", workspace_id: "3" });
  expect((cfg.containers["acme/web"] as any).account).toBeUndefined();
});

test("resolveContainer returns correct ids for a known alias", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "mysecret" });
  const r = resolveContainer(cfg, "acme/web");
  expect(r).toEqual({ alias: "acme/web", accountId: "111", containerId: "222", workspaceId: "3" });
});

test("resolveContainer throws on unknown alias", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "mysecret" });
  expect(() => resolveContainer(cfg, "nope")).toThrow(/Unknown container alias/);
});

test("parseConfig throws when referenced env var is missing", () => {
  expect(() => parseConfig(TOML, {})).toThrow(/missing env var/);
});
