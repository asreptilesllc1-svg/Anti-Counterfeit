import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Keys come from Render / env vars
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;

if (!PRIVATE_KEY || !PUBLIC_KEY) {
  console.error("❌ PRIVATE_KEY or PUBLIC_KEY missing in environment variables");
}

// Simple health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Anti-counterfeit backend running" });
});

// Optional: SIGN endpoint (can sign arbitrary payloads)
app.post("/sign", (req, res) => {
  const payload = req.body && Object.keys(req.body).length
    ? req.body
    : { id: "TEST-DEFAULT", name: "Default Product", timestamp: Date.now() };

  try {
    const signedToken = jwt.sign(
      { data: payload },
      PRIVATE_KEY,
      { algorithm: "RS256" }
    );

    res.json({ signedToken });
  } catch (error) {
    console.error("Sign error:", error);
    res.status(400).json({ error: "Signing failed" });
  }
});

// ✅ VERIFY endpoint used by verify.html
app.post("/verify-token", (req, res) => {
  const { signedToken } = req.body || {};

  if (!signedToken) {
    return res.status(400).json({
      valid: false,
      error: "signedToken missing",
    });
  }

  try {
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, {
      algorithms: ["RS256"],
    });

    // decoded looks like { data: { ...payload... }, iat, exp? }
    res.json({
      valid: true,
      payload: decoded.data,
    });
  } catch (error) {
    console.error("Verify error:", error);
    res.status(400).json({
      valid: false,
      error: "Invalid token",
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Backend running on port " + PORT);
});
