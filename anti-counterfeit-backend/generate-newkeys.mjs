import { writeFileSync } from "fs";
import crypto from "crypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

writeFileSync("new_private.pem", privateKey);
writeFileSync("new_public.pem", publicKey);

console.log("Generated: new_private.pem + new_public.pem");
