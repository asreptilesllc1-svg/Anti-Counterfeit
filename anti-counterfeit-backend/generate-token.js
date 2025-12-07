import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// For local use: read private key from file if env var not set
const privateKey = process.env.PRIVATE_KEY ||
  fs.readFileSync(path.join(__dirname, "private.pem"), "utf8");

// Example payload – this is what describes the product
const payload = {
  id: "TEST-001",
  name: "Phone Test",
  batch: "B1",
  timestamp: Date.now(),
};

// Sign as a JWT with RS256
const signedToken = jwt.sign(
  { data: payload },
  privateKey,
  { algorithm: "RS256" }
);

console.log("SIGNED_TOKEN:");
console.log(signedToken);

