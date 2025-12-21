import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import pg from "pg";

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
    rejectUnauthorized: false // Required for Render PostgreSQL
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

// ================================
// HELPER FUNCTIONS
// ================================

// Calculate risk level based on verification count
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

// Extract IP from request
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         'unknown';
}

// ================================
// HEALTH CHECK
// ================================
app.get("/", async (req, res) => {
  try {
    // Check database connection
    const dbCheck = await pool.query('SELECT NOW()');
    
    res.json({ 
      status: "ok", 
      message: "Anti-counterfeit backend running",
      database: "connected",
      timestamp: dbCheck.rows[0].now,
      endpoints: [
        "/sign-qr",
        "/verify-token", 
        "/products",
        "/verifications",
        "/analytics"
      ],
      version: "3.0.0-database"
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
// SIGN + QR ENDPOINT
// ================================
app.post("/sign-qr", async (req, res) => {
  const payload = req.body && Object.keys(req.body).length
    ? req.body
    : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY missing in environment");
    return res.status(500).json({ 
      error: "Server configuration error: PRIVATE_KEY not set" 
    });
  }

  try {
    // Sign the payload with JWT
    const signedToken = jwt.sign({ data: payload }, PRIVATE_KEY, {
      algorithm: "RS256",
      expiresIn: "10y" // Token expires in 10 years
    });

    // Create verification URL
    const verifyUrl = "https://verify.myproductauth.com/verify.html?p=" + 
      encodeURIComponent(signedToken);

    // Generate QR code
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    // 🗄️ SAVE TO DATABASE
    try {
      // Check if product already exists
      const existingProduct = await pool.query(
        'SELECT id FROM products WHERE product_id = $1',
        [payload.id]
      );

      if (existingProduct.rows.length === 0) {
        // Insert new product
        await pool.query(
          `INSERT INTO products (product_id, name, batch, qr_data_url, signed_token, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            payload.id,
            payload.name,
            payload.batch || 'N/A',
            qrDataUrl,
            signedToken,
            payload.notes || null
          ]
        );
        console.log(`✅ Product saved to database: ${payload.id}`);
      } else {
        // Update existing product
        await pool.query(
          `UPDATE products 
           SET name = $2, batch = $3, qr_data_url = $4, signed_token = $5
           WHERE product_id = $1`,
          [payload.id, payload.name, payload.batch || 'N/A', qrDataUrl, signedToken]
        );
        console.log(`✅ Product updated in database: ${payload.id}`);
      }

      // Log the QR generation in audit log
      await pool.query(
        'INSERT INTO audit_log (action, details) VALUES ($1, $2)',
        ['QR_GENERATED', `Product: ${payload.id} - ${payload.name}`]
      );

    } catch (dbErr) {
      console.error('❌ Database error:', dbErr);
      // Continue even if database save fails
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
// VERIFY TOKEN ENDPOINT
// ================================
app.post("/verify-token", async (req, res) => {
  const { signedToken } = req.body || {};

  if (!signedToken) {
    return res.status(400).json({ 
      valid: false, 
      error: "signedToken missing from request body" 
    });
  }

  if (!PUBLIC_KEY) {
    console.error("❌ PUBLIC_KEY missing in environment");
    return res.status(500).json({ 
      valid: false, 
      error: "Server configuration error: PUBLIC_KEY not set" 
    });
  }

  // Get client IP and user agent
  const ipAddress = getClientIP(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  try {
    // Verify the JWT token
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, { 
      algorithms: ["RS256"] 
    });

    const productId = decoded.data.id || "unknown";

    // Check if product is active in database
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
      // Product has been deactivated (e.g., reported stolen)
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

    // Calculate risk level
    const risk = await calculateRiskLevel(productId);

    // 🗄️ SAVE VERIFICATION TO DATABASE
    try {
      await pool.query(
        `INSERT INTO verifications (product_id, is_valid, risk_level, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [productId, true, risk, ipAddress, userAgent]
      );
    } catch (dbErr) {
      console.error('❌ Error saving verification:', dbErr);
      // Continue even if save fails
    }

    // Get total verification count for this product
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
    
    // Log failed verification
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

// Get all products
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
    
    // Get total count
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

// Get single product
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

// Deactivate product
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

// Reactivate product
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

// Get all verifications
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

// Get suspicious verifications
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
  console.log(`   POST /sign-qr                - Generate signed QR code`);
  console.log(`   POST /verify-token           - Verify product authenticity`);
  console.log(`   GET  /products               - List all products`);
  console.log(`   GET  /products/:id           - Get product details`);
  console.log(`   POST /products/:id/activate  - Activate product`);
  console.log(`   POST /products/:id/deactivate - Deactivate product`);
  console.log(`   GET  /verifications          - List verifications`);
  console.log(`   GET  /verifications/suspicious - Suspicious activity`);
  console.log(`   GET  /analytics/overview     - Analytics overview`);
  console.log(`   GET  /analytics/by-date      - Analytics by date`);
  console.log(`   GET  /analytics/by-product   - Top products`);
  
  if (!PRIVATE_KEY || !PUBLIC_KEY) {
    console.warn(`⚠️  WARNING: Keys not set in environment variables!`);
  } else {
    console.log(`✅ Cryptographic keys loaded`);
  }

  if (!process.env.DATABASE_URL) {
    console.error(`❌ DATABASE_URL not set!`);
  }
});