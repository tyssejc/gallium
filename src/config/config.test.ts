import { test, expect } from "bun:test";
import { parseConfig, resolveContainer } from "./config.ts";

const TOML = `
[accounts.acme]
mode = "oauth"
client_id = "cid"
client_secret = "\${env:GALLIUM_SECRET}"

[accounts.sa]
mode = "service_account"
key_file = "/keys/sa.json"

[containers."acme/web"]
account = "acme"
account_id = "111"
container_id = "222"
workspace_id = "3"
`;

test("parseConfig substitutes env in secrets and reads both auth modes", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "shh" });
  expect(cfg.accounts.acme).toEqual({ mode: "oauth", client_id: "cid", client_secret: "shh" });
  expect(cfg.accounts.sa).toEqual({ mode: "service_account", key_file: "/keys/sa.json" });
});

test("resolveContainer joins container to its account", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "shh" });
  const r = resolveContainer(cfg, "acme/web");
  expect(r).toMatchObject({ accountId: "111", containerId: "222", workspaceId: "3", accountName: "acme" });
  expect(r.account.mode).toBe("oauth");
});

test("resolveContainer throws on unknown alias", () => {
  const cfg = parseConfig(TOML, { GALLIUM_SECRET: "shh" });
  expect(() => resolveContainer(cfg, "nope")).toThrow(/Unknown container alias/);
});
