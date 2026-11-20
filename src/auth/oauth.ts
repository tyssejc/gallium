export const TAGMANAGER_READONLY_SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly";
export const TAGMANAGER_EDIT_CONTAINERS_SCOPE = "https://www.googleapis.com/auth/tagmanager.edit.containers";
const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

export async function refreshAccessToken(
  clientId: string, clientSecret: string, refreshToken: string, fetchFn: typeof fetch = fetch,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetchFn(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`OAuth refresh failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

// Interactive: returns a refresh_token and the scope Google granted. Uses a loopback redirect on an ephemeral port.
export async function loginOAuth(clientId: string, clientSecret: string, scopes: string[],
): Promise<{ refreshToken: string; scope: string }> {
  const server = Bun.serve({ port: 0, fetch() { return new Response(""); } });
  const redirectUri = `http://127.0.0.1:${server.port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      server.reload({
        fetch(req) {
          const url = new URL(req.url);
          const c = url.searchParams.get("code");
          if (c) { resolve(c); return new Response("gallium: authorized. You can close this tab."); }
          const err = url.searchParams.get("error");
          if (err) { reject(new Error(`OAuth error: ${err}`)); return new Response(`error: ${err}`); }
          return new Response("waiting…");
        },
      });
      const authUrl = `${AUTH_URI}?` + new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code",
        scope: scopes.join(" "), access_type: "offline", prompt: "consent",
      });
      console.error(`Opening browser to authorize:\n${authUrl}`);
      // Best-effort open; user can paste the URL manually if this fails.
      Bun.spawn(["open", authUrl]).exited.catch(() => {});
    });
    const res = await fetch(TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code,
        grant_type: "authorization_code", redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`OAuth code exchange failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { refresh_token?: string; scope?: string };
    if (!body.refresh_token) throw new Error("No refresh_token returned (try revoking prior consent).");
    return { refreshToken: body.refresh_token, scope: body.scope ?? scopes.join(" ") };
  } finally { server.stop(true); }
}
