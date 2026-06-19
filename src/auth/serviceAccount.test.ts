import { test, expect } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { signServiceAccountJwt, exchangeJwtForToken } from "./serviceAccount.ts";

test("signServiceAccountJwt produces a verifiable RS256 JWT with correct claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyJson = { client_email: "sa@x.iam.gserviceaccount.com", private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token" };
  const jwt = signServiceAccountJwt(keyJson, "scopeA", 1000);
  const [h, p, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  expect(claims).toMatchObject({ iss: keyJson.client_email, scope: "scopeA", aud: keyJson.token_uri, iat: 1000, exp: 4600 });
  const v = createVerify("RSA-SHA256"); v.update(`${h}.${p}`); v.end();
  expect(v.verify(createPublicKey(publicKey.export({ type: "spki", format: "pem" }).toString()),
    Buffer.from(sig, "base64url"))).toBe(true);
});

test("exchangeJwtForToken happy path: extracts access_token, expires_in and validates request", async () => {
  const key = { client_email: "x@example.com", private_key: "y", token_uri: "https://oauth2.googleapis.com/token" };
  let capturedUrl = "";
  let capturedBody: URLSearchParams | null = null;
  const mockFetch = async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = new URLSearchParams(init.body as string);
    return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
  };
  const result = await exchangeJwtForToken(key, "the.jwt.here", mockFetch);
  expect(result.access_token).toBe("test-token");
  expect(result.expires_in).toBe(3600);
  expect(capturedUrl).toBe(key.token_uri);
  expect(capturedBody!.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  expect(capturedBody!.get("assertion")).toBe("the.jwt.here");
});

test("exchangeJwtForToken error path: rejects with status code on failure", async () => {
  const key = { client_email: "x@example.com", private_key: "y", token_uri: "https://oauth2.googleapis.com/token" };
  const mockFetch = async () => new Response("denied", { status: 401 });
  await expect(exchangeJwtForToken(key, "the.jwt.here", mockFetch)).rejects.toThrow(/401/);
});
