import { test, expect } from "bun:test";
import { configPath, cacheDbPath, tokenCachePath, skillInstallDir, versionDbPath } from "./paths.ts";

const env = { HOME: "/home/u", XDG_CONFIG_HOME: "", XDG_CACHE_HOME: "" };

test("configPath honors HOME default", () => {
  expect(configPath(env)).toBe("/home/u/.config/gallium/config.toml");
});
test("cacheDbPath is namespaced per alias", () => {
  expect(cacheDbPath("acme/web", env)).toBe("/home/u/.cache/gallium/acme/web.db");
});
test("XDG_CONFIG_HOME overrides HOME", () => {
  expect(configPath({ ...env, XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gallium/config.toml");
});
test("skillInstallDir honors CLAUDE_CONFIG_DIR", () => {
  expect(skillInstallDir({ ...env, CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/skills/gallium");
});

test("versionDbPath keys the cache file by alias and version id", () => {
  const env = { HOME: "/home/u", XDG_CACHE_HOME: "/c" };
  expect(versionDbPath("acme/web", "42", env)).toBe("/c/gallium/acme/web@v42.db");
  expect(versionDbPath("acme/web", "42", { HOME: "/home/u" })).toBe("/home/u/.cache/gallium/acme/web@v42.db");
});
