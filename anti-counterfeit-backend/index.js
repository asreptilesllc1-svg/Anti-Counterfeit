import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ==========================
// ENVIRONMENT VARIABLES
// ==========================
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!PUBLIC_KEY || !DATABASE_URL) {
  console.error("❌ Missing PUBLIC_KEY or DATABASE_URL");
}

// ==========================
// DATABASE CONNECTION
// ==========================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==========================
// UTIL
// ==========================
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ==========================
// HEALTH CHECK
// ==========================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "anti-counterfeit-backend" });
});

// ==========================
// VERIFY TOKEN
// ==========================
app.post("/verify-token", async (req, res) => {
  const { signedToken } = req.body || {};

  if (!signedToken) {
    return res.status(400).json({
      valid: false,
      error: "No token provided",
    });
  }

  try {
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, {
      algorithms: ["RS256"],
    });

    const tokenHash = hashToken(signedToken);

    await pool.query(
      `INSERT INTO scans (token_hash, ip, user_agent)
       VALUES ($1, $2, $3)`,
      [
        tokenHash,
        req.headers["x-forwarded-for"] || req.socket.remoteAddress,
        req.headers["user-agent"],
      ]
    );

    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM scans WHERE token_hash = $1`,
      [tokenHash]
    );

    const scanCount = Number(rows[0].count);

    let risk = "low";
    if (scanCount > 5) risk = "medium";
    if (scanCount > 20) risk = "high";

    return res.json({
      valid: true,
      risk,
      payload: decoded.data,
    });
  } catch (err) {
    console.error("Verify error:", err.message);
    return res.status(400).json({
      valid: false,
      error: "Invalid token",
    });
  }
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
