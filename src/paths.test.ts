import { test, expect } from "bun:test";
import { configPath, cacheDbPath, tokenCachePath, skillInstallDir } from "./paths.ts";

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
