import { writeFileSync } from "fs";
import crypto from "crypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

writeFileSync("private.pem", privateKey);
writeFileSync("public.pem", publicKey);
console.log(" Generated new private.pem and public.pem");
