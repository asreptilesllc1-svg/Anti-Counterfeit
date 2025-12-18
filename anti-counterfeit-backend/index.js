import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ==============================
// 🔐 ENVIRONMENT VARIABLES
// ==============================
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!PUBLIC_KEY || !DATABASE_URL) {
  console.error("❌ Missing PUBLIC_KEY or DATABASE_URL in environment variables");
}

// ==============================
// 🗄️ DATABASE CONNECTION
// ==============================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==============================
// 🩺 HEALTH CHECK
// ==============================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Anti-Counterfeit Backend" });
});

// ==============================
// ✅ VERIFY + TRACK SCAN
// ==============================
app.post("/verify-token", async (req, res) => {
  const { signedToken } = req.body || {};

  if (!signedToken) {
    return res.status(400).json({
      valid: false,
      error: "No token provided",
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(signedToken, PUBLIC_KEY, {
      algorithms: ["RS256"],
    });
  } catch (err) {
    console.error("JWT verify failed:", err.message);
    return res.status(400).json({
      valid: false,
      error: "Invalid or tampered token",
    });
  }

  const payload = decoded.data;
  const productId = payload.id;

  try {
    // ------------------------------
    // 1️⃣ UPSERT PRODUCT
    // ------------------------------
    await pool.query(
      `
      INSERT INTO products (product_id, metadata)
      VALUES ($1, $2)
      ON CONFLICT (product_id) DO NOTHING
      `,
      [productId, payload]
    );

    // ------------------------------
    // 2️⃣ LOG SCAN
    // ------------------------------
    await pool.query(
      `
      INSERT INTO scans (product_id, scanned_at)
      VALUES ($1, NOW())
      `,
      [productId]
    );

    // ------------------------------
    // 3️⃣ COUNT SCANS
    // ------------------------------
    const result = await pool.query(
      `
      SELECT COUNT(*) FROM scans
      WHERE product_id = $1
      `,
      [productId]
    );

    const scanCount = parseInt(result.rows[0].count, 10);

    // ------------------------------
    // 4️⃣ RESPOND
    // ------------------------------
    res.json({
      valid: true,
      status:
        scanCount === 1
          ? "AUTHENTIC"
          : "DUPLICATE SCAN DETECTED",
      scanCount,
      product: payload,
    });
  } catch (dbErr) {
    console.error("Database error:", dbErr);
    res.status(500).json({
      valid: false,
      error: "Database failure",
    });
  }
});

// ==============================
// 🚀 START SERVER
// ==============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
