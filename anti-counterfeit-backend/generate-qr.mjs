// generate-qr.js
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";

// === Locate backend directory ===
const __dirname = path.resolve();

// === Load private key (env var preferred) ===
const privateKey =
  process.env.PRIVATE_KEY ||
  fs.readFileSync(path.join(__dirname, "private.pem"), "utf8");

// === EDIT THIS PAYLOAD TO DEFINE YOUR PRODUCT ===
const payload = {
  id: "TEST-001",
  name: "Phone Test",
  batch: "B1",
  timestamp: Date.now(),
};

// === Create signed JWT token ===
const token = jwt.sign(
  { data: payload },
  privateKey,
  { algorithm: "RS256" }
);

// Display token in console
console.log("\nSIGNED TOKEN:\n" + token + "\n");

// === Save QR code containing ONLY THE TOKEN ===
QRCode.toFile(
  "product-qr.png",
  token,
  { width: 1200 },
  (err) => {
    if (err) throw err;
    console.log("✅ QR code saved as product-qr.png");
  }
);
