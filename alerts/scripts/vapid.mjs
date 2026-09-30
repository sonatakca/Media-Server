// Prints a fresh VAPID key pair for the alert service.
//   node alerts/scripts/vapid.mjs
// The public key goes in wrangler.toml; the private JWK is set with
//   npx wrangler secret put VAPID_PRIVATE_JWK
import { webcrypto } from "node:crypto";

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const raw = new Uint8Array(
  await webcrypto.subtle.exportKey("raw", pair.publicKey),
);
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = Buffer.from(raw).toString("base64url");
console.log(JSON.stringify({ publicKey, privateJwk }));
