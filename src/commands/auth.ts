import type { Cmd } from "../command.ts";
import { configPath } from "../paths.ts";
import { loadConfig } from "../config/config.ts";
import { loginOAuth } from "../auth/oauth.ts";
import { oauthRefreshPath } from "../auth/token.ts";
import { ensureDirFor } from "../util/fs.ts";
import { chmod } from "node:fs/promises";

// gallium login — OAuth once; the token works for every container you can access.
export const cmdLogin: Cmd = async () => {
  const cfg = await loadConfig(configPath());
  if (!cfg.oauth) throw new Error("No [oauth] block in config. Add client_id and client_secret, then run 'gallium login'.");
  const refreshToken = await loginOAuth(cfg.oauth.client_id, cfg.oauth.client_secret);
  const path = oauthRefreshPath();
  await ensureDirFor(path);
  await Bun.write(path, refreshToken);
  await chmod(path, 0o600);
  console.log("Logged in. You can now pull any container you have access to.");
  return 0;
};
