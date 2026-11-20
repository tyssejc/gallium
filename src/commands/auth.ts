import type { Cmd } from "../command.ts";
import { configPath, tokenCachePath } from "../paths.ts";
import { loadConfig } from "../config/config.ts";
import { loginOAuth, TAGMANAGER_READONLY_SCOPE, TAGMANAGER_EDIT_CONTAINERS_SCOPE } from "../auth/oauth.ts";
import { oauthRefreshPath, oauthScopePath } from "../auth/token.ts";
import { ensureDirFor } from "../util/fs.ts";
import { chmod, rm } from "node:fs/promises";

async function writePrivate(path: string, content: string): Promise<void> {
  await ensureDirFor(path);
  await Bun.write(path, content);
  await chmod(path, 0o600);
}

// Seam for tests: the real loginOAuth opens a browser.
export async function runLogin(
  flags: Record<string, unknown>, deps: { loginOAuth: typeof loginOAuth },
): Promise<number> {
  const cfg = await loadConfig(configPath());
  if (!cfg.oauth) throw new Error("No [oauth] block in config. Add client_id and client_secret, then run 'gallium login'.");
  const write = flags.write === true;
  const scopes = write ? [TAGMANAGER_READONLY_SCOPE, TAGMANAGER_EDIT_CONTAINERS_SCOPE] : [TAGMANAGER_READONLY_SCOPE];
  const { refreshToken, scope } = await deps.loginOAuth(cfg.oauth.client_id, cfg.oauth.client_secret, scopes);
  await writePrivate(oauthRefreshPath(), refreshToken);
  await writePrivate(oauthScopePath(), scope);
  // A cached access token carries the old grant's scope; drop it.
  await rm(tokenCachePath("oauth"), { force: true });
  console.log(write
    ? "Logged in with write access (workspace edits only; gallium cannot publish)."
    : "Logged in. You can now pull any container you have access to.");
  return 0;
}

// gallium login [--write] — OAuth once; the token works for every container you can access.
export const cmdLogin: Cmd = (_rest, flags) => runLogin(flags, { loginOAuth });
