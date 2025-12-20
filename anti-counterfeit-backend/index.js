import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Keys come from Render / env vars
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;

const PORT = process.env.PORT || 10000;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Anti-counterfeit backend running" });
});

// SIGN endpoint
// Returns: signedToken + verifyUrl
app.post("/sign", async (req, res) => {
  const payload =
    req.body && Object.keys(req.body).length
      ? req.body
      : { id: "TEST-DEFAULT", name: "Default Product", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "PRIVATE_KEY missing in environment" });
  }

  try {
    const signedToken = jwt.sign({ data: payload }, PRIVATE_KEY, {
      algorithm: "RS256",
    });

    const verifyUrl =
      "https://verify.myproductauth.com/verify.html?p=" +
      encodeURIComponent(signedToken);

    res.json({ signedToken, verifyUrl });
  } catch (err) {
    console.error("Sign error:", err);
    res.status(400).json({ error: "Signing failed" });
  }
});

// SIGN + QR endpoint (NO frontend QR library needed)
// Returns: signedToken + verifyUrl + qrDataUrl (PNG)
app.post("/sign-qr", async (req, res) => {
  const payload =
    req.body && Object.keys(req.body).length
      ? req.body
      : { id: "TEST-DEFAULT", name: "Default Product", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "PRIVATE_KEY missing in environment" });
  }

  try {
    const signedToken = jwt.sign({ data: payload }, PRIVATE_KEY, {
      algorithm: "RS256",
    });

    const verifyUrl =
      "https://verify.myproductauth.com/verify.html?p=" +
      encodeURIComponent(signedToken);

    // Black/white QR, high error correction, strong size for easy scanning
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    res.json({ signedToken, verifyUrl, qrDataUrl });
  } catch (err) {
    console.error("Sign-QR error:", err);
    res.status(400).json({ error: "QR generation failed" });
  }
});

// VERIFY endpoint (used by verify.html)
app.post("/verify-token", (req, res) => {
  const { signedToken } = req.body || {};

  if (!signedToken) {
    return res.status(400).json({ valid: false, error: "signedToken missing" });
  }

  if (!PUBLIC_KEY) {
    return res.status(500).json({ valid: false, error: "PUBLIC_KEY missing in environment" });
  }

  try {
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, { algorithms: ["RS256"] });

    res.json({
      valid: true,
      payload: decoded.data,
    });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(400).json({ valid: false, error: "Invalid token" });
  }
});

app.listen(PORT, () => {
  console.log("🚀 Backend running on port " + PORT);
});
