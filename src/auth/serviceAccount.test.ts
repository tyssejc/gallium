import { test, expect } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { signServiceAccountJwt } from "./serviceAccount.ts";

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
