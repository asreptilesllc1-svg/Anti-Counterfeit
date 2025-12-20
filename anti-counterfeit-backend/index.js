import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

/* ===============================
   ENVIRONMENT VARIABLES
================================ */
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!PUBLIC_KEY || !DATABASE_URL) {
  console.error("❌ Missing PUBLIC_KEY or DATABASE_URL");
}

/* ===============================
   DATABASE
================================ */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===============================
   HELPERS
================================ */
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function getCountryFromIP(ip) {
  // Simple placeholder (future upgradeable)
  if (!ip) return "Unknown";
  if (ip.startsWith("192.") || ip.startsWith("127.")) return "Local";
  return "Unknown";
}

/* ===============================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Anti-counterfeit backend running" });
});

/* ===============================
   SIGN TOKEN
================================ */
app.post("/sign", (req, res) => {
  try {
    const payload = req.body;
    const signedToken = jwt.sign(
      { data: payload },
      PRIVATE_KEY,
      { algorithm: "RS256" }
    );
    res.json({ signedToken });
  } catch (err) {
    res.status(400).json({ error: "Signing failed" });
  }
});

/* ===============================
   VERIFY + TRACK SCAN
================================ */
app.post("/verify-token", async (req, res) => {
  const { signedToken } = req.body;

  if (!signedToken) {
    return res.status(400).json({ valid: false, error: "No token provided" });
  }

  try {
    // Verify JWT
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, {
      algorithms: ["RS256"],
    });

    const tokenHash = hashToken(signedToken);
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress;

    const country = await getCountryFromIP(ip);

    // Count previous scans
    const { rows } = await pool.query(
      "SELECT COUNT(*) FROM product_scans WHERE token_hash = $1",
      [tokenHash]
    );

    const scanCount = parseInt(rows[0].count, 10);

    // Insert new scan
    await pool.query(
      "INSERT INTO product_scans (token_hash, ip_address, country) VALUES ($1, $2, $3)",
      [tokenHash, ip, country]
    );

    res.json({
      valid: true,
      payload: decoded.data,
      scanCount: scanCount + 1,
      cloneRisk: scanCount >= 1,
      location: country,
    });
  } catch (err) {
    console.error("Verify error:", err.message);
    res.status(400).json({ valid: false, error: "Invalid token" });
  }
});

/* ===============================
   START SERVER
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Backend running on port " + PORT);
});
