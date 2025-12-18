import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";

const app = express();
app.use(cors());
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;

if (!PRIVATE_KEY || !PUBLIC_KEY) {
  console.error("❌ PRIVATE_KEY or PUBLIC_KEY missing in environment variables");
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Anti-counterfeit backend running" });
});


// 🔐 SIGN ENDPOINT (THIS WAS MISSING)
app.post("/sign", (req, res) => {
  try {
    const payload = {
      id: req.body.id,
      name: req.body.name,
      batch: req.body.batch,
      timestamp: Date.now(),
    };

    const signedToken = jwt.sign(
      { data: payload },
      PRIVATE_KEY,
      { algorithm: "RS256" }
    );

    res.json({ signedToken });
  } catch (err) {
    console.error("Sign error:", err);
    res.status(400).json({ error: "Signing failed" });
  }
});


// ✅ VERIFY ENDPOINT
app.post("/verify-token", (req, res) => {
  const { signedToken } = req.body;

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

    res.json({
      valid: true,
      payload: decoded.data,
    });
  } catch (err) {
    console.error("Verify error:", err);
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
