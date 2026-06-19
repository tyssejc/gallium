import { ensureDirFor } from "../util/fs.ts";
import { tokenCachePath } from "../paths.ts";
import type { AccountAuth } from "../config/config.ts";
import { refreshAccessToken, TAGMANAGER_READONLY_SCOPE } from "./oauth.ts";
import { exchangeJwtForToken, signServiceAccountJwt, type ServiceAccountKey } from "./serviceAccount.ts";

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
  return fresh.access_token;
}

// Production entrypoint: builds the right refresher for the account's auth mode.
export async function getAccountToken(accountName: string, account: AccountAuth): Promise<string> {
  const cachePath = tokenCachePath(accountName);
  if (account.mode === "service_account") {
    const key = (await Bun.file(account.key_file).json()) as ServiceAccountKey;
    return getAccessToken({
      cachePath, nowMs: Date.now(),
      refresher: () => exchangeJwtForToken(key, signServiceAccountJwt(key,
        TAGMANAGER_READONLY_SCOPE, Math.floor(Date.now() / 1000))),
    });
  }
  // OAuth: refresh token was stored at login time next to the access-token cache.
  const refreshPath = `${cachePath}.refresh`;
  const refreshToken = (await Bun.file(refreshPath).text()).trim();
  return getAccessToken({
    cachePath, nowMs: Date.now(),
    refresher: () => refreshAccessToken(account.client_id, account.client_secret, refreshToken),
  });
}
