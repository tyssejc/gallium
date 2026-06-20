import { createSign } from "node:crypto";

export interface ServiceAccountKey {
  client_email: string; private_key: string; token_uri: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signServiceAccountJwt(key: ServiceAccountKey, scope: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: key.client_email, scope, aud: key.token_uri, iat: nowSec, exp: nowSec + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`); signer.end();
  const sig = b64url(signer.sign(key.private_key));
  return `${header}.${payload}.${sig}`;
}

export async function exchangeJwtForToken(
  key: ServiceAccountKey, jwt: string, fetchFn: typeof fetch = fetch,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetchFn(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Service-account token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}
