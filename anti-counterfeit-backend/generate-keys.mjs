import crypto from "crypto";
import fs from "fs";

console.log("🔐 Generating fresh RSA keypair...");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

fs.writeFileSync("private.pem", privateKey);
fs.writeFileSync("public.pem", publicKey);

console.log("✅ Generated private.pem and public.pem");
console.log("");
console.log("Next steps:");
console.log("1. Copy the contents of private.pem into Render's PRIVATE_KEY env var");
console.log("2. Copy the contents of public.pem into Render's PUBLIC_KEY env var");
console.log("3. Never commit private.pem to git (it's in .gitignore)");
