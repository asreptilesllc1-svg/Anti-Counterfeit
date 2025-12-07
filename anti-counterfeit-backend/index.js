import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// Load keys (must match the key you used in generate-token.js)
const privateKeyPem = fs.readFileSync(path.join(__dirname, "private.pem"), "utf8");
const publicKeyPem = fs.readFileSync(path.join(__dirname, "public.pem"), "utf8");

// Helper: base64url decode JSON token
function decodeSignedToken(signedToken) {
  const json = Buffer.from(signedToken, "base64url").toString("utf8");
  return JSON.parse(json);
}

// Root health check
app.get("/", (req, res) => {
  res.send("Anti-counterfeit backend is running");
});

// Sign endpoint (optional, for future use)
app.post("/sign", (req, res) => {
  const clientData = req.body?.data || req.body || {};

  const data = {
    ...clientData,
    timestamp: Date.now(),
  };

  const payloadJson = JSON.stringify(data);
  const signatureBase64 = crypto
    .sign("sha256", Buffer.from(payloadJson), privateKeyPem)
    .toString("base64");

  const tokenObject = { data, sig: signatureBase64 };
  const tokenJson = JSON.stringify(tokenObject);
  const signedToken = Buffer.from(tokenJson).toString("base64url");

  res.json({
    payload: data,
    signature: signatureBase64,
    signedToken,
  });
});

// ✅ Verify endpoint, used by verify.html
app.post("/verify-token", (req, res) => {
  const { signedToken } = req.body || {};
  if (!signedToken) {
    return res.status(400).json({ valid: false, error: "signedToken missing" });
  }

  try {
    const token = decodeSignedToken(signedToken); // { data, sig }
    const { data, sig } = token;

    if (!data || !sig) {
      return res
        .status(400)
        .json({ valid: false, error: "Token missing data or sig" });
    }

    const payloadJson = JSON.stringify(data);
    const signatureBuf = Buffer.from(sig, "base64");

    const isValid = crypto.verify(
      "sha256",
      Buffer.from(payloadJson),
      publicKeyPem,
      signatureBuf
    );

    return res.json({
      valid: isValid,
      payload: isValid ? data : null,
    });
  } catch (err) {
    console.error("Verify error:", err);
    return res
      .status(400)
      .json({ valid: false, error: "Invalid token format or signature" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
