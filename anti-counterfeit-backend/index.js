// index.js
import express from "express";
import cors from "cors";
import crypto from "crypto";
import QRCode from "qrcode";
import pako from "pako";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3001;
const KEY_ENV_NAME = "PRIVATE_KEY_PEM";

// --- Load or derive keys --------------------------------------------------
let PRIVATE_PEM = process.env[KEY_ENV_NAME] || null;
let PUBLIC_PEM = null;

if (!PRIVATE_PEM) {
  // dev fallback: load local private.pem if exists (only for local dev)
  const localPath = path.join(process.cwd(), "private.pem");
  if (fs.existsSync(localPath)) {
    PRIVATE_PEM = fs.readFileSync(localPath, "utf8");
    console.warn("Loaded private.pem from disk (dev). In production use env var PRIVATE_KEY_PEM.");
  }
}

if (PRIVATE_PEM) {
  try {
    // create a KeyObject from private key, then derive public key PEM
    const keyObj = crypto.createPrivateKey({ key: PRIVATE_PEM, format: "pem", type: "pkcs8" });
    const pubKeyObj = crypto.createPublicKey(keyObj);
    PUBLIC_PEM = pubKeyObj.export({ type: "spki", format: "pem" });
  } catch (err) {
    console.error("Failed to derive public key from PRIVATE_KEY_PEM:", err.message);
    // continue - fallback to generated keys below
    PRIVATE_PEM = null;
  }
}

if (!PRIVATE_PEM) {
  // No private key provided -> generate ephemeral pair (dev only)
  console.warn("No PRIVATE_KEY_PEM found. Generating ephemeral keypair (dev only).");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
  PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });
}

// --- Helpers ---------------------------------------------------------------
function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// base64 <-> Uint8Array helpers for browser/fetch compatibility
function base64ToUint8Array(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf);
}

// --- Routes ---------------------------------------------------------------

// health
app.get("/", (req, res) => res.send("Anti-counterfeit backend running"));

// public key endpoint
app.get("/publicKey", (req, res) => {
  res.type("text/plain").send(PUBLIC_PEM);
});

// POST /sign
app.post("/sign", async (req, res) => {
  try {
    const { id, name, meta } = req.body;
    if (!id || !name) return res.status(400).json({ error: "id and name required" });

    const payload = {
      id,
      name,
      meta: meta || {},
      issuedAt: Date.now(),
      issuer: "myproductauth"
    };

    // deterministic canonical JSON for signing
    const payloadJson = canonicalize(payload);

    const signer = crypto.createSign("SHA256");
    signer.update(payloadJson);
    signer.end();
    const signatureB64 = signer.sign(PRIVATE_PEM).toString("base64");

    const signedData = { payload, signature: signatureB64 };

    // compress as binary, then base64 encode -> signedToken
    const compressed = pako.deflate(JSON.stringify(signedData)); // Uint8Array
    const signedToken = Buffer.from(compressed).toString("base64");

    // generate QR data URL for quick preview
    const qrDataUrl = await QRCode.toDataURL(signedToken, { errorCorrectionLevel: "M" });

    res.json({
      payload,
      signature: signatureB64,
      signedToken,
      qr: qrDataUrl,
      publicKeyUrl: `${req.protocol}://${req.get("host")}/publicKey`
    });
  } catch (err) {
    console.error("Error /sign:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /verify
app.post("/verify", (req, res) => {
  try {
    const { signedToken, payload, signature } = req.body;
    let payloadObj, sigB64;

    if (signedToken) {
      // decode base64 -> inflate -> parse JSON
      const compressed = Buffer.from(signedToken, "base64");
      const inflated = pako.inflate(compressed, { to: "string" });
      const parsed = JSON.parse(inflated);
      payloadObj = parsed.payload;
      sigB64 = parsed.signature;
    } else if (payload && signature) {
      payloadObj = payload;
      sigB64 = signature;
    } else {
      return res.status(400).json({ error: "expected signedToken OR payload+signature" });
    }

    // verify signature (use canonicalize)
    const payloadJson = canonicalize(payloadObj);
    const verifier = crypto.createVerify("SHA256");
    verifier.update(payloadJson);
    verifier.end();
    const ok = verifier.verify(PUBLIC_PEM, Buffer.from(sigB64, "base64"));

    return res.json({ valid: !!ok, payload: payloadObj });
  } catch (err) {
    console.error("Error /verify:", err);
    return res.status(400).json({ error: "invalid token or payload" });
  }
});

// start server
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
