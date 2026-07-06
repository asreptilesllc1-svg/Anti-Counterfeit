import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "canvas";
import pg from "pg";
import fs from "fs";

const { Pool } = pg;
const app = express();

// ================================
// CORS — locked to the verification site only.
// (Server-to-server tools like PowerShell are unaffected; CORS governs browsers.)
// ================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://verify.myproductauth.com")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (curl, PowerShell, mobile apps, same-origin)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  })
);

app.use(express.json({ limit: "10mb" }));

// ================================
// CONFIG
// ================================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const PORT = process.env.PORT || 10000;
const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || "https://verify.myproductauth.com";
const EXPORT_KEY = process.env.EXPORT_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const LOGO_PATH = "./logo.png";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query("SELECT NOW()", (err) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Database connected successfully!");
  }
});

// ================================
// HELPERS
// ================================
async function calculateRiskLevel(productId) {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM verifications WHERE product_id = $1 AND verified_at > NOW() - INTERVAL '24 hours'",
      [productId]
    );
    const count = parseInt(result.rows[0].count);
    if (count > 10) return "high";
    if (count > 3) return "medium";
    return "low";
  } catch (err) {
    console.error("Error calculating risk:", err);
    return "low";
  }
}

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

async function generateQRWithLogo(data, logoBuffer, options = {}) {
  const { size = 800, margin = 2, logoSize = 0.2, logoBorderRadius = 10 } = options;

  const qrCanvas = createCanvas(size, size);
  await QRCode.toCanvas(qrCanvas, data, {
    errorCorrectionLevel: "H",
    margin,
    width: size,
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  const ctx = qrCanvas.getContext("2d");

  if (logoBuffer) {
    try {
      const logo = await loadImage(logoBuffer);
      const logoWidth = size * logoSize;
      const logoHeight = size * logoSize;
      const logoX = (size - logoWidth) / 2;
      const logoY = (size - logoHeight) / 2;
      const padding = 10;

      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.roundRect(logoX - padding, logoY - padding, logoWidth + padding * 2, logoHeight + padding * 2, logoBorderRadius);
      ctx.fill();
      ctx.drawImage(logo, logoX, logoY, logoWidth, logoHeight);

      console.log("✅ Logo added to QR code");
    } catch (err) {
      console.warn("⚠️  Could not add logo:", err.message);
    }
  }

  return qrCanvas.toDataURL("image/png");
}

// ================================
// SECURITY MIDDLEWARE
// ================================

// Admin authentication — required for anything that creates, changes,
// or reveals business data. Key is sent in the "x-admin-key" header.
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: "ADMIN_KEY not configured on server - admin endpoints disabled" });
  }
  const provided = req.headers["x-admin-key"];
  if (!provided || provided !== ADMIN_KEY) {
    return res.status(403).json({ error: "Invalid or missing admin key" });
  }
  next();
}

// Lightweight in-memory rate limiter (per IP, per window).
// Suitable for a single-instance service; resets on restart.
const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = getClientIP(req);
    const key = `${req.path}:${ip}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: "Too many requests - slow down" });
    }
    next();
  };
}

// Periodically clean old buckets so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 15 * 60 * 1000) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });   // 30 verifications/min per IP
const adminLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });    // 60 admin ops/min per IP
const exportLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });    // 5 exports/min per IP

// ================================
// HEALTH CHECK
// ================================
app.get("/", async (req, res) => {
  try {
    const dbCheck = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      database: "connected",
      timestamp: dbCheck.rows[0].now,
      version: "1.2.0",
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: "Database connection failed" });
  }
});

// ================================
// SIGN + QR (no logo)
// ================================
app.post("/sign-qr", requireAdmin, adminLimiter, async (req, res) => {
  const payload =
    req.body && Object.keys(req.body).length
      ? req.body
      : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "PRIVATE_KEY not set" });
  }

  try {
    const signedToken = jwt.sign({ data: payload }, PRIVATE_KEY, { algorithm: "RS256", expiresIn: "10y" });
    const verifyUrl = `${VERIFY_BASE_URL}/verify.html?p=${encodeURIComponent(signedToken)}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    try {
      const existingProduct = await pool.query("SELECT id FROM products WHERE product_id = $1", [payload.id]);
      if (existingProduct.rows.length === 0) {
        await pool.query(
          `INSERT INTO products (product_id, name, batch, qr_data_url, signed_token, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
          [payload.id, payload.name, payload.batch || "N/A", qrDataUrl, signedToken, payload.notes || null]
        );
        console.log(`✅ Product saved: ${payload.id}`);
      } else {
        await pool.query(
          `UPDATE products SET name = $2, batch = $3, qr_data_url = $4, signed_token = $5 WHERE product_id = $1`,
          [payload.id, payload.name, payload.batch || "N/A", qrDataUrl, signedToken]
        );
        console.log(`✅ Product updated: ${payload.id}`);
      }
      await pool.query("INSERT INTO audit_log (action, details) VALUES ($1, $2)", [
        "QR_GENERATED",
        `Product: ${payload.id} - ${payload.name}`,
      ]);
    } catch (dbErr) {
      console.error("❌ Database error:", dbErr);
    }

    res.json({ signedToken, verifyUrl, qrDataUrl, productId: payload.id });
  } catch (err) {
    console.error("❌ Sign-QR error:", err);
    res.status(400).json({ error: "QR generation failed: " + err.message });
  }
});

// ================================
// SIGN + QR (with logo)
// ================================
app.post("/sign-qr-with-logo", requireAdmin, adminLimiter, async (req, res) => {
  const { logo, ...payload } = req.body;
  const productData =
    Object.keys(payload).length > 0
      ? payload
      : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "PRIVATE_KEY not set" });
  }

  try {
    const signedToken = jwt.sign({ data: productData }, PRIVATE_KEY, { algorithm: "RS256", expiresIn: "10y" });
    const verifyUrl = `${VERIFY_BASE_URL}/verify.html?p=${encodeURIComponent(signedToken)}`;

    let logoBuffer = null;
    if (logo) {
      const base64Data = logo.replace(/^data:image\/\w+;base64,/, "");
      logoBuffer = Buffer.from(base64Data, "base64");
      console.log("📸 Using uploaded logo");
    } else if (fs.existsSync(LOGO_PATH)) {
      logoBuffer = fs.readFileSync(LOGO_PATH);
      console.log("📸 Using server default logo");
    }

    const qrDataUrl = await generateQRWithLogo(verifyUrl, logoBuffer, { size: 800, logoSize: 0.2, margin: 2 });

    try {
      const existingProduct = await pool.query("SELECT id FROM products WHERE product_id = $1", [productData.id]);
      if (existingProduct.rows.length === 0) {
        await pool.query(
          `INSERT INTO products (product_id, name, batch, qr_data_url, signed_token, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
          [productData.id, productData.name, productData.batch || "N/A", qrDataUrl, signedToken, productData.notes || null]
        );
        console.log(`✅ Product with logo saved: ${productData.id}`);
      } else {
        await pool.query(
          `UPDATE products SET name = $2, batch = $3, qr_data_url = $4, signed_token = $5 WHERE product_id = $1`,
          [productData.id, productData.name, productData.batch || "N/A", qrDataUrl, signedToken]
        );
        console.log(`✅ Product with logo updated: ${productData.id}`);
      }
      await pool.query("INSERT INTO audit_log (action, details) VALUES ($1, $2)", [
        "QR_WITH_LOGO_GENERATED",
        `Product: ${productData.id} - ${productData.name}`,
      ]);
    } catch (dbErr) {
      console.error("❌ Database error:", dbErr);
    }

    res.json({ signedToken, verifyUrl, qrDataUrl, productId: productData.id, hasLogo: !!logoBuffer });
  } catch (err) {
    console.error("❌ Sign-QR-with-Logo error:", err);
    res.status(400).json({ error: "QR generation failed: " + err.message });
  }
});

// ================================
// VERIFY TOKEN
// ================================
app.post("/verify-token", verifyLimiter, async (req, res) => {
  const { signedToken } = req.body || {};
  if (!signedToken) {
    return res.status(400).json({ valid: false, error: "signedToken missing" });
  }
  if (!PUBLIC_KEY) {
    return res.status(500).json({ valid: false, error: "PUBLIC_KEY not set" });
  }

  const ipAddress = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, { algorithms: ["RS256"] });
    const productId = decoded.data.id || "unknown";

    let isActive = true;
    let inscriptionId = null;
    try {
      const productCheck = await pool.query("SELECT is_active, inscription_id FROM products WHERE product_id = $1", [productId]);
      if (productCheck.rows.length > 0) {
        isActive = productCheck.rows[0].is_active;
        inscriptionId = productCheck.rows[0].inscription_id || null;
      }
    } catch (dbErr) {
      console.error("Error checking product status:", dbErr);
    }

    if (!isActive) {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent, error_message) VALUES ($1, $2, $3, $4, $5, $6)`,
        [productId, false, "high", ipAddress, userAgent, "Product deactivated"]
      );
      return res.json({ valid: false, error: "This product has been deactivated", payload: decoded.data, risk: "high" });
    }

    const risk = await calculateRiskLevel(productId);

    try {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)`,
        [productId, true, risk, ipAddress, userAgent]
      );
    } catch (dbErr) {
      console.error("❌ Error saving verification:", dbErr);
    }

    let scanCount = 0;
    try {
      const countResult = await pool.query("SELECT COUNT(*) as count FROM verifications WHERE product_id = $1", [productId]);
      scanCount = parseInt(countResult.rows[0].count);
    } catch (err) {
      console.error("Error getting scan count:", err);
    }

    console.log(`✅ Verified product: ${productId} (scan #${scanCount}, risk: ${risk})`);
    res.json({ valid: true, payload: decoded.data, risk, scanCount, inscriptionId });
  } catch (err) {
    console.error("❌ Verify error:", err.message);
    try {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent, error_message) VALUES ($1, $2, $3, $4, $5, $6)`,
        ["unknown", false, "high", ipAddress, userAgent, err.message]
      );
    } catch (dbErr) {
      console.error("Error logging failed verification:", dbErr);
    }
    res.status(400).json({ valid: false, error: "Invalid or expired token", details: err.message });
  }
});

// ================================
// PRODUCTS
// ================================
app.get("/products", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { search, active, limit = 50, offset = 0 } = req.query;
    let query = "SELECT * FROM product_stats WHERE 1=1";
    const params = [];
    let paramCount = 1;

    if (search) {
      query += ` AND (product_id ILIKE $${paramCount} OR name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }
    if (active !== undefined) {
      query += ` AND is_active = $${paramCount}`;
      params.push(active === "true");
      paramCount++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query("SELECT COUNT(*) FROM products");
    res.json({ products: result.rows, total: parseInt(countResult.rows[0].count), limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/products/:id", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM product_stats WHERE product_id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

app.post("/products/:id/deactivate", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query("UPDATE products SET is_active = false WHERE product_id = $1 RETURNING *", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    await pool.query("INSERT INTO audit_log (action, details) VALUES ($1, $2)", ["PRODUCT_DEACTIVATED", `Product: ${req.params.id}`]);
    res.json({ message: "Product deactivated", product: result.rows[0] });
  } catch (err) {
    console.error("Error deactivating product:", err);
    res.status(500).json({ error: "Failed to deactivate product" });
  }
});

app.post("/products/:id/activate", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query("UPDATE products SET is_active = true WHERE product_id = $1 RETURNING *", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    await pool.query("INSERT INTO audit_log (action, details) VALUES ($1, $2)", ["PRODUCT_ACTIVATED", `Product: ${req.params.id}`]);
    res.json({ message: "Product activated", product: result.rows[0] });
  } catch (err) {
    console.error("Error activating product:", err);
    res.status(500).json({ error: "Failed to activate product" });
  }
});

// ================================
// BLOCKCHAIN INSCRIPTION (Doginals)
// ================================

// Generate the manifest JSON to inscribe for a product.
// Inscribe this EXACT output (it includes a hash of the signed token,
// proving the token existed at inscription time without bloating the chain).
app.get("/products/:id/manifest", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT product_id, name, batch, signed_token, notes FROM products WHERE product_id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    const p = result.rows[0];
    if (!p.signed_token) {
      return res.status(400).json({ error: "Product has no signed token yet - generate its QR first" });
    }

    const crypto = await import("crypto");
    const tokenHash = crypto.createHash("sha256").update(p.signed_token).digest("hex");

    const manifest = {
      p: "anti-counterfeit-v1",
      product_id: p.product_id,
      name: p.name,
      batch: p.batch || undefined,
      token_sha256: tokenHash,
      verify: VERIFY_BASE_URL,
      ts: new Date().toISOString().slice(0, 10),
    };

    res.json({
      manifest,
      inscribeThis: JSON.stringify(manifest),
      instructions: "Inscribe the 'inscribeThis' string as text/plain via a Doginals inscription service, then POST the resulting inscription ID to /products/:id/inscription",
    });
  } catch (err) {
    console.error("Error building manifest:", err);
    res.status(500).json({ error: "Failed to build manifest" });
  }
});

// Record the inscription ID after inscribing (one-time, final step per product).
app.post("/products/:id/inscription", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { inscriptionId } = req.body || {};
    if (!inscriptionId || typeof inscriptionId !== "string" || inscriptionId.length > 200) {
      return res.status(400).json({ error: "inscriptionId (string) required" });
    }

    const existing = await pool.query("SELECT inscription_id FROM products WHERE product_id = $1", [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    if (existing.rows[0].inscription_id) {
      return res.status(409).json({
        error: "Product already has an inscription recorded - inscriptions are permanent, refusing to overwrite",
        current: existing.rows[0].inscription_id,
      });
    }

    const result = await pool.query(
      "UPDATE products SET inscription_id = $2 WHERE product_id = $1 RETURNING product_id, inscription_id",
      [req.params.id, inscriptionId.trim()]
    );
    await pool.query("INSERT INTO audit_log (action, details) VALUES ($1, $2)", [
      "INSCRIPTION_RECORDED",
      `Product: ${req.params.id} → ${inscriptionId.trim()}`,
    ]);
    res.json({ message: "Inscription recorded", product: result.rows[0] });
  } catch (err) {
    console.error("Error recording inscription:", err);
    res.status(500).json({ error: "Failed to record inscription" });
  }
});

// ================================
// VERIFICATIONS
// ================================
app.get("/verifications", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { product_id, risk, from, to, limit = 100, offset = 0 } = req.query;
    let query = "SELECT * FROM verifications WHERE 1=1";
    const params = [];
    let paramCount = 1;

    if (product_id) {
      query += ` AND product_id = $${paramCount}`;
      params.push(product_id);
      paramCount++;
    }
    if (risk) {
      query += ` AND risk_level = $${paramCount}`;
      params.push(risk);
      paramCount++;
    }
    if (from) {
      query += ` AND verified_at >= $${paramCount}`;
      params.push(from);
      paramCount++;
    }
    if (to) {
      query += ` AND verified_at <= $${paramCount}`;
      params.push(to);
      paramCount++;
    }

    query += ` ORDER BY verified_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    res.json({ verifications: result.rows, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    console.error("Error fetching verifications:", err);
    res.status(500).json({ error: "Failed to fetch verifications" });
  }
});

app.get("/verifications/suspicious", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM suspicious_activity LIMIT 100");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching suspicious activity:", err);
    res.status(500).json({ error: "Failed to fetch suspicious activity" });
  }
});

// ================================
// ANALYTICS
// ================================
app.get("/analytics/overview", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM products) as total_products,
        (SELECT COUNT(*) FROM products WHERE is_active = true) as active_products,
        (SELECT COUNT(*) FROM verifications) as total_verifications,
        (SELECT COUNT(*) FROM verifications WHERE verified_at > NOW() - INTERVAL '24 hours') as verifications_today,
        (SELECT COUNT(*) FROM verifications WHERE risk_level = 'high') as high_risk_verifications
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    console.error("Error fetching analytics:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

app.get("/analytics/by-date", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const safeDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    const result = await pool.query(
      "SELECT * FROM daily_stats WHERE date > CURRENT_DATE - ($1 || ' days')::INTERVAL ORDER BY date ASC",
      [safeDays]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching date analytics:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

app.get("/analytics/by-product", requireAdmin, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.product_id, p.name, COUNT(v.id) as verification_count
      FROM products p
      LEFT JOIN verifications v ON p.product_id = v.product_id
      GROUP BY p.product_id, p.name
      ORDER BY verification_count DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching product analytics:", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// ================================
// BACKUP / EXPORT
// ================================
function checkExportKey(req, res) {
  const providedKey = req.query.key;
  if (!EXPORT_KEY) {
    res.status(500).json({ error: "EXPORT_KEY not configured on server" });
    return false;
  }
  if (!providedKey || providedKey !== EXPORT_KEY) {
    res.status(403).json({ error: "Invalid or missing export key" });
    return false;
  }
  return true;
}

function toCSV(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    if (val === null || val === undefined) return "";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

// Full backup of every product: includes qr_data_url (the actual QR image)
// and signed_token (what the QR encodes). This is the critical data to
// keep an off-site copy of for anything tagging physical merchandise.
app.get("/export/products", exportLimiter, async (req, res) => {
  if (!checkExportKey(req, res)) return;

  try {
    const result = await pool.query("SELECT * FROM products ORDER BY created_at ASC");
    const format = req.query.format === "csv" ? "csv" : "json";

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="products-backup-${Date.now()}.csv"`);
      return res.send(toCSV(result.rows));
    }

    res.setHeader("Content-Disposition", `attachment; filename="products-backup-${Date.now()}.json"`);
    res.json({ exportedAt: new Date().toISOString(), count: result.rows.length, products: result.rows });
  } catch (err) {
    console.error("Error exporting products:", err);
    res.status(500).json({ error: "Failed to export products" });
  }
});

// Full backup of every verification/scan event (the audit trail)
app.get("/export/verifications", exportLimiter, async (req, res) => {
  if (!checkExportKey(req, res)) return;

  try {
    const result = await pool.query("SELECT * FROM verifications ORDER BY verified_at ASC");
    const format = req.query.format === "csv" ? "csv" : "json";

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="verifications-backup-${Date.now()}.csv"`);
      return res.send(toCSV(result.rows));
    }

    res.setHeader("Content-Disposition", `attachment; filename="verifications-backup-${Date.now()}.json"`);
    res.json({ exportedAt: new Date().toISOString(), count: result.rows.length, verifications: result.rows });
  } catch (err) {
    console.error("Error exporting verifications:", err);
    res.status(500).json({ error: "Failed to export verifications" });
  }
});

// ================================
// START SERVER
// ================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📊 Endpoints available:`);
  console.log(`   GET  /                       - Health check`);
  console.log(`   POST /sign-qr                - Generate QR (no logo)`);
  console.log(`   POST /sign-qr-with-logo      - Generate QR WITH logo`);
  console.log(`   POST /verify-token           - Verify authenticity`);
  console.log(`   GET  /products               - List products`);
  console.log(`   GET  /analytics/overview     - Analytics`);
  console.log(`   GET  /export/products        - Backup export (requires EXPORT_KEY)`);
  console.log(`   GET  /export/verifications   - Backup export (requires EXPORT_KEY)`);

  if (!EXPORT_KEY) {
    console.warn(`⚠️  WARNING: EXPORT_KEY not set - backup export endpoints are disabled`);
  }

  if (!ADMIN_KEY) {
    console.warn(`🔴 CRITICAL: ADMIN_KEY not set - QR generation and admin endpoints are DISABLED until it is configured`);
  } else {
    console.log(`🔒 Admin endpoints protected (ADMIN_KEY set)`);
  }

  console.log(`🌐 CORS allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);

  if (!PRIVATE_KEY || !PUBLIC_KEY) {
    console.warn(`⚠️  WARNING: Keys not set!`);
  } else {
    console.log(`✅ Cryptographic keys loaded`);
  }

  if (!process.env.DATABASE_URL) {
    console.error(`❌ DATABASE_URL not set!`);
  }

  if (fs.existsSync(LOGO_PATH)) {
    console.log(`🎨 Default logo found: ${LOGO_PATH}`);
  } else {
    console.log(`ℹ️  No default logo - clients can upload their own`);
  }
});
