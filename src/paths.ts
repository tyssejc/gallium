type Env = Record<string, string | undefined>;

function base(env: Env, xdgVar: string, fallback: string): string {
  const xdg = env[xdgVar];
  if (xdg && xdg.length > 0) return xdg;
  return `${env.HOME ?? ""}/${fallback}`;
}

export function configPath(env: Env = process.env): string {
  return `${base(env, "XDG_CONFIG_HOME", ".config")}/gallium/config.toml`;
}
export function statePath(env: Env = process.env): string {
  return `${base(env, "XDG_CONFIG_HOME", ".config")}/gallium/state.toml`;
}
export function cacheDir(env: Env = process.env): string {
  return `${base(env, "XDG_CACHE_HOME", ".cache")}/gallium`;
}
export function cacheDbPath(alias: string, env: Env = process.env): string {
  return `${cacheDir(env)}/${alias}.db`;
}
export function versionDbPath(alias: string, versionId: string, env: Env = process.env): string {
  return `${cacheDir(env)}/${alias}@v${versionId}.db`;
}
export function tokenCachePath(account: string, env: Env = process.env): string {
  return `${cacheDir(env)}/.tokens/${account}.json`;
}
export function skillInstallDir(env: Env = process.env): string {
  const claudeDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : `${env.HOME ?? ""}/.claude`;
  return `${claudeDir}/skills/gallium`;
}
export function rateLimitPath(env: Env = process.env): string {
  return `${cacheDir(env)}/.ratelimit.json`;
}
