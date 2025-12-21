import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Keys from Render environment variables
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const PORT = process.env.PORT || 10000;

// In-memory verification tracking
const verificationLog = new Map();

// ================================
// HEALTH CHECK
// ================================
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "Anti-counterfeit backend running",
    endpoints: ["/sign-qr", "/verify-token"],
    version: "1.0.0"
  });
});

// ================================
// SIGN + QR ENDPOINT (Used by generate.html)
// ================================
app.post("/sign-qr", async (req, res) => {
  const payload = req.body && Object.keys(req.body).length
    ? req.body
    : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  // Check for private key
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
    });

    // Create verification URL
    const verifyUrl = "https://verify.myproductauth.com/verify.html?p=" + 
      encodeURIComponent(signedToken);

    // Generate QR code from the verification URL
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    // Log generation
    console.log(`✅ Generated QR for product: ${payload.id || 'unknown'}`);

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
// VERIFY TOKEN ENDPOINT (Used by verify.html)
// ================================
app.post("/verify-token", (req, res) => {
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

  try {
    // Verify the JWT token
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, { 
      algorithms: ["RS256"] 
    });

    // Track verification attempts
    const productId = decoded.data.id || "unknown";
    const count = (verificationLog.get(productId) || 0) + 1;
    verificationLog.set(productId, count);

    // Determine risk level based on scan count
    let risk = "low";
    if (count > 5) risk = "high";
    else if (count > 2) risk = "medium";

    console.log(`✅ Verified product: ${productId} (scan #${count}, risk: ${risk})`);

    res.json({
      valid: true,
      payload: decoded.data,
      risk: risk,
      scanCount: count
    });

  } catch (err) {
    console.error("❌ Verify error:", err.message);
    res.status(400).json({ 
      valid: false, 
      error: "Invalid or expired token",
      details: err.message 
    });
  }
});

// ================================
// ADMIN: Get verification stats
// ================================
app.get("/stats", (req, res) => {
  const stats = Array.from(verificationLog.entries()).map(([id, count]) => ({
    productId: id,
    scans: count
  }));

  res.json({
    totalProducts: verificationLog.size,
    products: stats
  });
});

// ================================
// START SERVER
// ================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📊 Endpoints available:`);
  console.log(`   GET  /           - Health check`);
  console.log(`   POST /sign-qr    - Generate signed QR code`);
  console.log(`   POST /verify-token - Verify product authenticity`);
  console.log(`   GET  /stats      - View verification statistics`);
  
  if (!PRIVATE_KEY || !PUBLIC_KEY) {
    console.warn(`⚠️  WARNING: Keys not set in environment variables!`);
    console.warn(`   Set PRIVATE_KEY and PUBLIC_KEY in Render dashboard`);
  } else {
    console.log(`✅ Cryptographic keys loaded successfully`);
  }
});