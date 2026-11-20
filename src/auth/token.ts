import { ensureDirFor } from "../util/fs.ts";
import { tokenCachePath } from "../paths.ts";
import type { Config } from "../config/config.ts";
import { refreshAccessToken, TAGMANAGER_READONLY_SCOPE, TAGMANAGER_EDIT_CONTAINERS_SCOPE } from "./oauth.ts";
import { exchangeJwtForToken, signServiceAccountJwt, type ServiceAccountKey } from "./serviceAccount.ts";
import { chmod } from "node:fs/promises";

interface CachedToken { access_token: string; expires_at_ms: number; }

interface CoreOpts {
  cachePath: string; nowMs: number;
  refresher: () => Promise<{ access_token: string; expires_in: number }>;
}

// Testable core: returns a valid token, refreshing through `refresher` when the
// cache is missing or within 5 minutes of expiry.
export async function getAccessToken(opts: CoreOpts): Promise<string> {
  const file = Bun.file(opts.cachePath);
  if (await file.exists()) {
    const cached = (await file.json()) as CachedToken;
    if (cached.expires_at_ms - opts.nowMs > 5 * 60_000) return cached.access_token;
  }
  const fresh = await opts.refresher();
  const next: CachedToken = { access_token: fresh.access_token, expires_at_ms: opts.nowMs + fresh.expires_in * 1000 };
  await ensureDirFor(opts.cachePath);
  await Bun.write(opts.cachePath, JSON.stringify(next));
  await chmod(opts.cachePath, 0o600);
  return fresh.access_token;
}

export function oauthRefreshPath(): string { return `${tokenCachePath("oauth")}.refresh`; }

export function oauthScopePath(): string { return `${tokenCachePath("oauth")}.scope`; }

// Gate for every write: only an OAuth login that was granted edit.containers may write.
export async function assertWriteAllowed(): Promise<void> {
  if (!(await Bun.file(oauthRefreshPath()).exists())) {
    throw new Error("Writes need an OAuth login; service account credentials are read-only. Run: gallium login --write");
  }
  const scopeFile = Bun.file(oauthScopePath());
  const scope = (await scopeFile.exists()) ? await scopeFile.text() : "";
  if (!scope.split(/\s+/).includes(TAGMANAGER_EDIT_CONTAINERS_SCOPE)) {
    throw new Error("This login is read-only. Run: gallium login --write");
  }
}

export async function getUserToken(cfg: Config): Promise<string> {
  const refreshPath = oauthRefreshPath();
  if (cfg.oauth && (await Bun.file(refreshPath).exists())) {
    const refreshToken = (await Bun.file(refreshPath).text()).trim();
    return getAccessToken({
      cachePath: tokenCachePath("oauth"), nowMs: Date.now(),
      refresher: () => refreshAccessToken(cfg.oauth!.client_id, cfg.oauth!.client_secret, refreshToken),
    });
  }
  if (cfg.serviceAccount) {
    const key = (await Bun.file(cfg.serviceAccount.key_file).json()) as ServiceAccountKey;
    return getAccessToken({
      cachePath: tokenCachePath("service_account"), nowMs: Date.now(),
      refresher: () => exchangeJwtForToken(key, signServiceAccountJwt(key, TAGMANAGER_READONLY_SCOPE, Math.floor(Date.now() / 1000))),
    });
  }
  if (cfg.oauth) throw new Error("Not logged in. Run: gallium login");
  throw new Error("No credentials configured. Add an [oauth] or [service_account] block to your config.");
}
