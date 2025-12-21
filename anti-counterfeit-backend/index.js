import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "canvas";
import pg from "pg";
import fs from "fs";

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 🔐 Keys from environment
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const PORT = process.env.PORT || 10000;

// 🗄️ PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected successfully!');
  }
});

// Logo settings
let cachedLogo = null;
const LOGO_PATH = './logo.png';

// ================================
// HELPER FUNCTIONS
// ================================

async function calculateRiskLevel(productId) {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM verifications WHERE product_id = $1 AND verified_at > NOW() - INTERVAL \'24 hours\'',
      [productId]
    );
    
    const count = parseInt(result.rows[0].count);
    
    if (count > 10) return 'high';
    if (count > 3) return 'medium';
    return 'low';
  } catch (err) {
    console.error('Error calculating risk:', err);
    return 'low';
  }
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         'unknown';
}

// Generate QR with logo
async function generateQRWithLogo(data, logoBuffer, options = {}) {
  const {
    size = 800,
    margin = 2,
    logoSize = 0.2,
    logoBorderRadius = 10
  } = options;

  const qrCanvas = createCanvas(size, size);
  await QRCode.toCanvas(qrCanvas, data, {
    errorCorrectionLevel: 'H',
    margin: margin,
    width: size,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });

  const ctx = qrCanvas.getContext('2d');

  if (logoBuffer) {
    try {
      const logo = await loadImage(logoBuffer);
      
      const logoWidth = size * logoSize;
      const logoHeight = size * logoSize;
      const logoX = (size - logoWidth) / 2;
      const logoY = (size - logoHeight) / 2;

      // White background
      const padding = 10;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.roundRect(
        logoX - padding, 
        logoY - padding, 
        logoWidth + (padding * 2), 
        logoHeight + (padding * 2),
        logoBorderRadius
      );
      ctx.fill();

      // Draw logo
      ctx.drawImage(logo, logoX, logoY, logoWidth, logoHeight);
      
      console.log('✅ Logo added to QR code');
    } catch (err) {
      console.warn('⚠️  Could not add logo:', err.message);
    }
  }

  return qrCanvas.toDataURL('image/png');
}

// ================================
// HEALTH CHECK
// ================================
app.get("/", async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW()');
    
    res.json({ 
      status: "ok", 
      message: "Anti-counterfeit backend running",
      database: "connected",
      timestamp: dbCheck.rows[0].now,
      endpoints: [
        "/sign-qr",
        "/sign-qr-with-logo",
        "/verify-token", 
        "/products",
        "/verifications",
        "/analytics"
      ],
      version: "3.1.0-database-logo"
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Database connection failed",
      error: err.message
    });
  }
});

// ================================
// SIGN + QR ENDPOINT (No Logo)
// ================================
app.post("/sign-qr", async (req, res) => {
  const payload = req.body && Object.keys(req.body).length
    ? req.body
    : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "PRIVATE_KEY not set" });
  }

  try {
    const signedToken = jwt.sign({ data: payload }, PRIVATE_KEY, {
      algorithm: "RS256",
      expiresIn: "10y"
    });

    const verifyUrl = "https://verify.myproductauth.com/verify.html?p=" + 
      encodeURIComponent(signedToken);

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    // Save to database
    try {
      const existingProduct = await pool.query(
        'SELECT id FROM products WHERE product_id = $1',
        [payload.id]
      );

      if (existingProduct.rows.length === 0) {
        await pool.query(
          `INSERT INTO products (product_id, name, batch, qr_data_url, signed_token, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [payload.id, payload.name, payload.batch || 'N/A', qrDataUrl, signedToken, payload.notes || null]
        );
        console.log(`✅ Product saved: ${payload.id}`);
      } else {
        await pool.query(
          `UPDATE products 
           SET name = $2, batch = $3, qr_data_url = $4, signed_token = $5
           WHERE product_id = $1`,
          [payload.id, payload.name, payload.batch || 'N/A', qrDataUrl, signedToken]
        );
        console.log(`✅ Product updated: ${payload.id}`);
      }

      await pool.query(
        'INSERT INTO audit_log (action, details) VALUES ($1, $2)',
        ['QR_GENERATED', `Product: ${payload.id} - ${payload.name}`]
      );

    } catch (dbErr) {
      console.error('❌ Database error:', dbErr);
    }

    res.json({ 
      signedToken, 
      verifyUrl, 
      qrDataUrl,
      productId: payload.id
    });

  } catch (err) {
    console.error("❌ Sign-QR error:", err);
    res.status(400).json({ error: "QR generation failed: " + err.message });
  }
});

// ================================
// SIGN + QR WITH LOGO ENDPOINT
// ================================
app.post("/sign-qr-with-logo", async (req, res) => {
  const { logo, ...payload } = req.body;
  
  const productData = Object.keys(payload).length > 0
    ? payload
    : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "PRIVATE_KEY not set" });
  }

  try {
    const signedToken = jwt.sign({ data: productData }, PRIVATE_KEY, {
      algorithm: "RS256",
      expiresIn: "10y"
    });

    const verifyUrl = "https://verify.myproductauth.com/verify.html?p=" + 
      encodeURIComponent(signedToken);

    // Determine logo source
    let logoBuffer = null;
    
    if (logo) {
      const base64Data = logo.replace(/^data:image\/\w+;base64,/, '');
      logoBuffer = Buffer.from(base64Data, 'base64');
      console.log('📸 Using uploaded logo');
    } else if (fs.existsSync(LOGO_PATH)) {
      logoBuffer = fs.readFileSync(LOGO_PATH);
      console.log('📸 Using server default logo');
    }

    const qrDataUrl = await generateQRWithLogo(verifyUrl, logoBuffer, {
      size: 800,
      logoSize: 0.2,
      margin: 2
    });

    // Save to database
    try {
      const existingProduct = await pool.query(
        'SELECT id FROM products WHERE product_id = $1',
        [productData.id]
      );

      if (existingProduct.rows.length === 0) {
        await pool.query(
          `INSERT INTO products (product_id, name, batch, qr_data_url, signed_token, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [productData.id, productData.name, productData.batch || 'N/A', qrDataUrl, signedToken, productData.notes || null]
        );
        console.log(`✅ Product with logo saved: ${productData.id}`);
      } else {
        await pool.query(
          `UPDATE products 
           SET name = $2, batch = $3, qr_data_url = $4, signed_token = $5
           WHERE product_id = $1`,
          [productData.id, productData.name, productData.batch || 'N/A', qrDataUrl, signedToken]
        );
        console.log(`✅ Product with logo updated: ${productData.id}`);
      }

      await pool.query(
        'INSERT INTO audit_log (action, details) VALUES ($1, $2)',
        ['QR_WITH_LOGO_GENERATED', `Product: ${productData.id} - ${productData.name}`]
      );

    } catch (dbErr) {
      console.error('❌ Database error:', dbErr);
    }

    res.json({ 
      signedToken, 
      verifyUrl, 
      qrDataUrl,
      productId: productData.id,
      hasLogo: !!logoBuffer
    });

  } catch (err) {
    console.error("❌ Sign-QR-with-Logo error:", err);
    res.status(400).json({ error: "QR generation failed: " + err.message });
  }
});

// ================================
// VERIFY TOKEN ENDPOINT
// ================================
app.post("/verify-token", async (req, res) => {
  const { signedToken } = req.body || {};

  if (!signedToken) {
    return res.status(400).json({ valid: false, error: "signedToken missing" });
  }

  if (!PUBLIC_KEY) {
    return res.status(500).json({ valid: false, error: "PUBLIC_KEY not set" });
  }

  const ipAddress = getClientIP(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  try {
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, { algorithms: ["RS256"] });
    const productId = decoded.data.id || "unknown";

    // Check if product is active
    let isActive = true;
    try {
      const productCheck = await pool.query(
        'SELECT is_active FROM products WHERE product_id = $1',
        [productId]
      );
      
      if (productCheck.rows.length > 0) {
        isActive = productCheck.rows[0].is_active;
      }
    } catch (dbErr) {
      console.error('Error checking product status:', dbErr);
    }

    if (!isActive) {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [productId, false, 'high', ipAddress, userAgent, 'Product deactivated']
      );

      return res.json({
        valid: false,
        error: "This product has been deactivated",
        payload: decoded.data,
        risk: 'high'
      });
    }

    const risk = await calculateRiskLevel(productId);

    // Save verification
    try {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [productId, true, risk, ipAddress, userAgent]
      );
    } catch (dbErr) {
      console.error('❌ Error saving verification:', dbErr);
    }

    // Get scan count
    let scanCount = 0;
    try {
      const countResult = await pool.query(
        'SELECT COUNT(*) as count FROM verifications WHERE product_id = $1',
        [productId]
      );
      scanCount = parseInt(countResult.rows[0].count);
    } catch (err) {
      console.error('Error getting scan count:', err);
    }

    console.log(`✅ Verified product: ${productId} (scan #${scanCount}, risk: ${risk})`);

    res.json({
      valid: true,
      payload: decoded.data,
      risk: risk,
      scanCount: scanCount
    });

  } catch (err) {
    console.error("❌ Verify error:", err.message);
    
    try {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['unknown', false, 'high', ipAddress, userAgent, err.message]
      );
    } catch (dbErr) {
      console.error('Error logging failed verification:', dbErr);
    }

    res.status(400).json({ 
      valid: false, 
      error: "Invalid or expired token",
      details: err.message 
    });
  }
});

// ================================
// PRODUCTS ENDPOINTS
// ================================

app.get("/products", async (req, res) => {
  try {
    const { search, active, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM product_stats WHERE 1=1';
    const params = [];
    let paramCount = 1;

    if (search) {
      query += ` AND (product_id ILIKE $${paramCount} OR name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    if (active !== undefined) {
      query += ` AND is_active = $${paramCount}`;
      params.push(active === 'true');
      paramCount++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM products');
    
    res.json({
      products: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get("/products/:id", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM product_stats WHERE product_id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching product:', err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

app.post("/products/:id/deactivate", async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE products SET is_active = false WHERE product_id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await pool.query(
      'INSERT INTO audit_log (action, details) VALUES ($1, $2)',
      ['PRODUCT_DEACTIVATED', `Product: ${req.params.id}`]
    );

    res.json({ 
      message: 'Product deactivated',
      product: result.rows[0]
    });
  } catch (err) {
    console.error('Error deactivating product:', err);
    res.status(500).json({ error: 'Failed to deactivate product' });
  }
});

app.post("/products/:id/activate", async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE products SET is_active = true WHERE product_id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await pool.query(
      'INSERT INTO audit_log (action, details) VALUES ($1, $2)',
      ['PRODUCT_ACTIVATED', `Product: ${req.params.id}`]
    );

    res.json({ 
      message: 'Product activated',
      product: result.rows[0]
    });
  } catch (err) {
    console.error('Error activating product:', err);
    res.status(500).json({ error: 'Failed to activate product' });
  }
});

// ================================
// VERIFICATIONS ENDPOINTS
// ================================

app.get("/verifications", async (req, res) => {
  try {
    const { product_id, risk, from, to, limit = 100, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM verifications WHERE 1=1';
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
    
    res.json({
      verifications: result.rows,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('Error fetching verifications:', err);
    res.status(500).json({ error: 'Failed to fetch verifications' });
  }
});

app.get("/verifications/suspicious", async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM suspicious_activity LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching suspicious activity:', err);
    res.status(500).json({ error: 'Failed to fetch suspicious activity' });
  }
});

// ================================
// ANALYTICS ENDPOINTS
// ================================

app.get("/analytics/overview", async (req, res) => {
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
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get("/analytics/by-date", async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const result = await pool.query(
      `SELECT * FROM daily_stats 
       WHERE date > CURRENT_DATE - INTERVAL '${parseInt(days)} days'
       ORDER BY date ASC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching date analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get("/analytics/by-product", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.product_id,
        p.name,
        COUNT(v.id) as verification_count
      FROM products p
      LEFT JOIN verifications v ON p.product_id = v.product_id
      GROUP BY p.product_id, p.name
      ORDER BY verification_count DESC
      LIMIT 20
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching product analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
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