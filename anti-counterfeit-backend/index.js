import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "canvas";
import pg from "pg";
import fs from "fs";
import crypto from "crypto";
import Stripe from "stripe";

const { Pool } = pg;
const app = express();

// ================================
// CORS
// ================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://verify.myproductauth.com")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  })
);

// Stripe webhook needs the raw body, so it must be registered BEFORE express.json()
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Stripe not configured");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe webhook signature invalid:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const accountId = session.client_reference_id;
        const plan = session.metadata?.plan || "starter";
        const limits = { starter: 50, growth: 250, business: 1500 };
        await pool.query(
          `UPDATE accounts SET plan = $1, plan_product_limit = $2, stripe_customer_id = $3, stripe_subscription_id = $4, subscription_status = 'active' WHERE id = $5`,
          [plan, limits[plan] || 50, session.customer, session.subscription, accountId]
        );
        console.log(`✅ Account ${accountId} activated on plan ${plan}`);
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const status = sub.status === "active" || sub.status === "trialing" ? "active" : sub.status;
        await pool.query(`UPDATE accounts SET subscription_status = $1 WHERE stripe_subscription_id = $2`, [status, sub.id]);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await pool.query(`UPDATE accounts SET subscription_status = 'canceled' WHERE stripe_subscription_id = $1`, [sub.id]);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        await pool.query(`UPDATE accounts SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`, [invoice.customer]);
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("❌ Error handling Stripe webhook:", err);
    res.status(500).send("Webhook handler failed");
  }
});

app.use(express.json({ limit: "10mb" }));

// ================================
// CONFIG
// ================================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PUBLIC_KEY = process.env.PUBLIC_KEY;
const PORT = process.env.PORT || 10000;
const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL || "https://verify.myproductauth.com";
const EXPORT_KEY = process.env.EXPORT_KEY; // platform-level full-backup key (you, not customers)
const ADMIN_KEY = process.env.ADMIN_KEY;   // platform-level superadmin key (you, not customers)
const LOGO_PATH = "./logo.png";

const PLAN_LIMITS = { free: 5, starter: 50, growth: 250, business: 1500 };
const STRIPE_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth: process.env.STRIPE_PRICE_GROWTH,
  business: process.env.STRIPE_PRICE_BUSINESS,
};

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "hello@myproductauth.com";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "ProductAuth";

async function sendEmail({ to, subject, html }) {
  if (!BREVO_API_KEY) {
    console.warn(`⚠️  Email not sent (BREVO_API_KEY not configured) - would have sent "${subject}" to ${to}`);
    return { sent: false };
  }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Brevo API returned ${res.status}: ${errBody}`);
    }
    return { sent: true };
  } catch (err) {
    console.error("❌ Failed to send email:", err.message);
    return { sent: false, error: err.message };
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function emailWrapper(title, bodyHtml) {
  return `
  <div style="font-family: 'IBM Plex Sans', -apple-system, sans-serif; background: #14171c; padding: 40px 20px; color: #edeef0;">
    <div style="max-width: 480px; margin: 0 auto; background: #1b1f26; border-radius: 16px; padding: 36px 32px; border: 1px solid rgba(237,238,240,0.1);">
      <div style="font-family: Georgia, serif; font-weight: 600; font-size: 19px; color: #edeef0; margin-bottom: 24px;">ProductAuth</div>
      <h1 style="font-family: Georgia, serif; font-size: 22px; color: #edeef0; margin: 0 0 16px;">${title}</h1>
      ${bodyHtml}
      <p style="color: #575d68; font-size: 12px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  </div>`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query("SELECT NOW()", (err) => {
  if (err) console.error("❌ Database connection failed:", err);
  else console.log("✅ Database connected successfully!");
});

// ================================
// PASSWORD / API KEY HELPERS (no external deps — Node's built-in crypto)
// ================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateApiKey() {
  return "pk_" + crypto.randomBytes(24).toString("hex");
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ================================
// HELPERS
// ================================
async function calculateRiskLevel(accountId, productId) {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM verifications WHERE account_id = $1 AND product_id = $2 AND verified_at > NOW() - INTERVAL '24 hours'",
      [accountId, productId]
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
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// Best-effort IP geolocation. Never throws, never blocks verification for long —
// a slow or failed lookup just means location stays null.
async function lookupLocation(ip) {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("::1") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
    return { country: null, city: null };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data && data.success !== false) {
      return { country: data.country || null, city: data.city || null };
    }
  } catch (err) {
    console.warn("⚠️  Location lookup failed:", err.message);
  }
  return { country: null, city: null };
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
    } catch (err) {
      console.warn("⚠️  Could not add logo:", err.message);
    }
  }
  return qrCanvas.toDataURL("image/png");
}

// ================================
// SECURITY MIDDLEWARE
// ================================

// Per-customer auth — looks up the account owning this API key.
// Every tenant-scoped route uses this; req.account is then available.
async function requireAccount(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing x-api-key header" });

  try {
    const result = await pool.query("SELECT * FROM accounts WHERE api_key = $1", [apiKey]);
    if (result.rows.length === 0) return res.status(403).json({ error: "Invalid API key" });

    const account = result.rows[0];
    if (!account.is_active) return res.status(403).json({ error: "Account deactivated" });
    if (!["active", "trialing"].includes(account.subscription_status)) {
      return res.status(402).json({ error: "Subscription inactive - please update billing", status: account.subscription_status });
    }
    req.account = account;
    next();
  } catch (err) {
    console.error("Error authenticating account:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

// Platform-level (you, not customers) — used for cross-account operations only.
function requireSuperAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "ADMIN_KEY not configured" });
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Invalid admin key" });
  next();
}

function checkExportKey(req, res) {
  if (!EXPORT_KEY) {
    res.status(500).json({ error: "EXPORT_KEY not configured" });
    return false;
  }
  if (req.query.key !== EXPORT_KEY) {
    res.status(403).json({ error: "Invalid or missing export key" });
    return false;
  }
  return true;
}

// Lightweight in-memory rate limiter (per key, per window)
const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.path}:${req.headers["x-api-key"] || getClientIP(req)}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) return res.status(429).json({ error: "Too many requests - slow down" });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 15 * 60 * 1000) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });     // signup/login attempts
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });   // public verification
const accountLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });  // authenticated account ops
const exportLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

async function enforceProductQuota(req, res, next) {
  try {
    // Free plan: lifetime cap (an evaluation tier, not a small forever-plan).
    // Paid plans: resets monthly.
    const isFree = req.account.plan === "free";
    const query = isFree
      ? "SELECT COUNT(*) as count FROM products WHERE account_id = $1"
      : "SELECT COUNT(*) as count FROM products WHERE account_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)";
    const result = await pool.query(query, [req.account.id]);
    const used = parseInt(result.rows[0].count);
    if (used >= req.account.plan_product_limit) {
      return res.status(403).json({
        error: isFree
          ? `Free plan limit reached (${req.account.plan_product_limit} products total). Upgrade to a paid plan to keep going.`
          : `Monthly product limit reached (${req.account.plan_product_limit} on the ${req.account.plan} plan). Upgrade to add more.`,
        used,
        limit: req.account.plan_product_limit,
        plan: req.account.plan,
      });
    }
    next();
  } catch (err) {
    console.error("Error checking quota:", err);
    res.status(500).json({ error: "Failed to check usage quota" });
  }
}

// ================================
// HEALTH CHECK
// ================================
app.get("/", async (req, res) => {
  try {
    const dbCheck = await pool.query("SELECT NOW()");
    res.json({ status: "ok", database: "connected", timestamp: dbCheck.rows[0].now, version: "2.0.0" });
  } catch (err) {
    res.status(500).json({ status: "error", message: "Database connection failed" });
  }
});

// ================================
// ACCOUNTS — signup, login, self-service
// ================================
app.post("/signup", authLimiter, async (req, res) => {
  const { email, password, businessName } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "Valid email required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  try {
    const existing = await pool.query("SELECT id FROM accounts WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: "An account with this email already exists" });

    const apiKey = generateApiKey();
    const passwordHash = hashPassword(password);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const result = await pool.query(
      `INSERT INTO accounts (email, password_hash, api_key, business_name, plan, plan_product_limit, subscription_status, verification_token_hash, verification_expires)
       VALUES ($1, $2, $3, $4, 'free', $5, 'active', $6, $7) RETURNING id, email, business_name, plan, api_key`,
      [email.toLowerCase(), passwordHash, apiKey, businessName || null, PLAN_LIMITS.free, hashToken(verificationToken), verificationExpires]
    );

    const verifyLink = `${VERIFY_BASE_URL}/verify-email.html?token=${verificationToken}`;
    await sendEmail({
      to: email,
      subject: "Verify your ProductAuth email",
      html: emailWrapper("Confirm your email", `
        <p style="color:#979da8; font-size:15px; line-height:1.6;">Welcome to ProductAuth. Click below to verify your email and activate your account.</p>
        <a href="${verifyLink}" style="display:inline-block; margin-top:12px; padding:12px 24px; background:#c9a227; color:#1a1508; text-decoration:none; border-radius:999px; font-weight:600; font-size:14px;">Verify email</a>
        <p style="color:#575d68; font-size:12px; margin-top:20px;">This link expires in 24 hours.</p>
      `),
    });

    console.log(`✅ New account signed up: ${email}`);
    res.status(201).json({ message: "Account created - check your email to verify", account: result.rows[0] });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  try {
    const result = await pool.query("SELECT * FROM accounts WHERE email = $1", [email.toLowerCase()]);
    if (result.rows.length === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const account = result.rows[0];
    res.json({
      apiKey: account.api_key,
      businessName: account.business_name,
      plan: account.plan,
      subscriptionStatus: account.subscription_status,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/verify-email", authLimiter, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Token required" });

  try {
    const tokenHash = hashToken(token);
    const result = await pool.query(
      "SELECT id, verification_expires FROM accounts WHERE verification_token_hash = $1",
      [tokenHash]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "Invalid or already-used verification link" });

    const account = result.rows[0];
    if (new Date(account.verification_expires) < new Date()) {
      return res.status(400).json({ error: "This verification link has expired - request a new one from your account" });
    }

    await pool.query(
      "UPDATE accounts SET email_verified = true, verification_token_hash = NULL, verification_expires = NULL WHERE id = $1",
      [account.id]
    );
    res.json({ message: "Email verified" });
  } catch (err) {
    console.error("Error verifying email:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "Valid email required" });

  try {
    const result = await pool.query("SELECT id FROM accounts WHERE email = $1", [email.toLowerCase()]);
    // Always return the same response whether or not the account exists,
    // so this endpoint can't be used to check which emails have accounts.
    if (result.rows.length > 0) {
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await pool.query("UPDATE accounts SET reset_token_hash = $1, reset_expires = $2 WHERE id = $3", [
        hashToken(resetToken), resetExpires, result.rows[0].id,
      ]);
      const resetLink = `${VERIFY_BASE_URL}/reset-password.html?token=${resetToken}`;
      await sendEmail({
        to: email,
        subject: "Reset your ProductAuth password",
        html: emailWrapper("Reset your password", `
          <p style="color:#979da8; font-size:15px; line-height:1.6;">Click below to set a new password. This link expires in 1 hour.</p>
          <a href="${resetLink}" style="display:inline-block; margin-top:12px; padding:12px 24px; background:#c9a227; color:#1a1508; text-decoration:none; border-radius:999px; font-weight:600; font-size:14px;">Reset password</a>
        `),
      });
    }
    res.json({ message: "If that email has an account, a reset link has been sent." });
  } catch (err) {
    console.error("Error requesting password reset:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

app.post("/reset-password", authLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Token and a password of at least 8 characters are required" });
  }

  try {
    const tokenHash = hashToken(token);
    const result = await pool.query("SELECT id, reset_expires FROM accounts WHERE reset_token_hash = $1", [tokenHash]);
    if (result.rows.length === 0) return res.status(400).json({ error: "Invalid or already-used reset link" });

    const account = result.rows[0];
    if (new Date(account.reset_expires) < new Date()) {
      return res.status(400).json({ error: "This reset link has expired - request a new one" });
    }

    await pool.query("UPDATE accounts SET password_hash = $1, reset_token_hash = NULL, reset_expires = NULL WHERE id = $2", [
      hashPassword(newPassword), account.id,
    ]);
    res.json({ message: "Password updated - you can log in now" });
  } catch (err) {
    console.error("Error resetting password:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

app.get("/account/me", requireAccount, accountLimiter, async (req, res) => {
  const a = req.account;
  res.json({
    email: a.email,
    emailVerified: a.email_verified,
    businessName: a.business_name,
    brandLogoUrl: a.brand_logo_url,
    brandColor: a.brand_color,
    plan: a.plan,
    planProductLimit: a.plan_product_limit,
    subscriptionStatus: a.subscription_status,
  });
});

app.post("/account/branding", requireAccount, accountLimiter, async (req, res) => {
  const { businessName, brandLogoUrl, brandColor } = req.body || {};
  try {
    await pool.query(
      "UPDATE accounts SET business_name = COALESCE($1, business_name), brand_logo_url = COALESCE($2, brand_logo_url), brand_color = COALESCE($3, brand_color) WHERE id = $4",
      [businessName || null, brandLogoUrl || null, brandColor || null, req.account.id]
    );
    res.json({ message: "Branding updated" });
  } catch (err) {
    console.error("Error updating branding:", err);
    res.status(500).json({ error: "Failed to update branding" });
  }
});

app.post("/account/regenerate-key", requireAccount, accountLimiter, async (req, res) => {
  try {
    const newKey = generateApiKey();
    await pool.query("UPDATE accounts SET api_key = $1 WHERE id = $2", [newKey, req.account.id]);
    res.json({ message: "API key regenerated - update it anywhere you use the old one", apiKey: newKey });
  } catch (err) {
    console.error("Error regenerating key:", err);
    res.status(500).json({ error: "Failed to regenerate key" });
  }
});

// ================================
// BILLING (Stripe)
// ================================
app.post("/billing/checkout", requireAccount, accountLimiter, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Billing is not configured yet" });
  const { plan } = req.body || {};
  const priceId = STRIPE_PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });

  try {
    let customerId = req.account.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.account.email });
      customerId = customer.id;
      await pool.query("UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2", [customerId, req.account.id]);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: String(req.account.id),
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { plan },
      success_url: `${VERIFY_BASE_URL}/dashboard.html?billing=success`,
      cancel_url: `${VERIFY_BASE_URL}/dashboard.html?billing=canceled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

app.post("/billing/portal", requireAccount, accountLimiter, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Billing is not configured yet" });
  if (!req.account.stripe_customer_id) return res.status(400).json({ error: "No billing account on file yet" });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.account.stripe_customer_id,
      return_url: `${VERIFY_BASE_URL}/dashboard.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating billing portal session:", err);
    res.status(500).json({ error: "Failed to open billing portal" });
  }
});

// ================================
// SIGN + QR (no logo)
// ================================
app.post("/sign-qr", requireAccount, accountLimiter, enforceProductQuota, async (req, res) => {
  const payload =
    req.body && Object.keys(req.body).length
      ? req.body
      : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) return res.status(500).json({ error: "PRIVATE_KEY not set" });

  try {
    const tokenPayload = { ...payload, account_id: req.account.id };
    const signedToken = jwt.sign({ data: tokenPayload }, PRIVATE_KEY, { algorithm: "RS256", expiresIn: "10y" });
    const verifyUrl = `${VERIFY_BASE_URL}/verify.html?p=${encodeURIComponent(signedToken)}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: "#000000", light: "#FFFFFF" },
    });

    const existing = await pool.query("SELECT id FROM products WHERE account_id = $1 AND product_id = $2", [req.account.id, payload.id]);
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO products (account_id, product_id, name, batch, qr_data_url, signed_token, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.account.id, payload.id, payload.name, payload.batch || "N/A", qrDataUrl, signedToken, payload.notes || null]
      );
    } else {
      await pool.query(
        `UPDATE products SET name = $3, batch = $4, qr_data_url = $5, signed_token = $6 WHERE account_id = $1 AND product_id = $2`,
        [req.account.id, payload.id, payload.name, payload.batch || "N/A", qrDataUrl, signedToken]
      );
    }
    await pool.query("INSERT INTO audit_log (account_id, action, details) VALUES ($1, $2, $3)", [
      req.account.id, "QR_GENERATED", `Product: ${payload.id} - ${payload.name}`,
    ]);

    res.json({ signedToken, verifyUrl, qrDataUrl, productId: payload.id });
  } catch (err) {
    console.error("❌ Sign-QR error:", err);
    res.status(400).json({ error: "QR generation failed: " + err.message });
  }
});

// ================================
// SIGN + QR (with logo)
// ================================
app.post("/sign-qr-with-logo", requireAccount, accountLimiter, enforceProductQuota, async (req, res) => {
  const { logo, ...payload } = req.body;
  const productData = Object.keys(payload).length > 0 ? payload : { id: "DEFAULT-001", name: "Default Product", batch: "DEFAULT", timestamp: Date.now() };

  if (!PRIVATE_KEY) return res.status(500).json({ error: "PRIVATE_KEY not set" });

  try {
    const tokenPayload = { ...productData, account_id: req.account.id };
    const signedToken = jwt.sign({ data: tokenPayload }, PRIVATE_KEY, { algorithm: "RS256", expiresIn: "10y" });
    const verifyUrl = `${VERIFY_BASE_URL}/verify.html?p=${encodeURIComponent(signedToken)}`;

    let logoBuffer = null;
    if (logo) {
      logoBuffer = Buffer.from(logo.replace(/^data:image\/\w+;base64,/, ""), "base64");
    } else if (fs.existsSync(LOGO_PATH)) {
      logoBuffer = fs.readFileSync(LOGO_PATH);
    }

    const qrDataUrl = await generateQRWithLogo(verifyUrl, logoBuffer, { size: 800, logoSize: 0.2, margin: 2 });

    const existing = await pool.query("SELECT id FROM products WHERE account_id = $1 AND product_id = $2", [req.account.id, productData.id]);
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO products (account_id, product_id, name, batch, qr_data_url, signed_token, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.account.id, productData.id, productData.name, productData.batch || "N/A", qrDataUrl, signedToken, productData.notes || null]
      );
    } else {
      await pool.query(
        `UPDATE products SET name = $3, batch = $4, qr_data_url = $5, signed_token = $6 WHERE account_id = $1 AND product_id = $2`,
        [req.account.id, productData.id, productData.name, productData.batch || "N/A", qrDataUrl, signedToken]
      );
    }
    await pool.query("INSERT INTO audit_log (account_id, action, details) VALUES ($1, $2, $3)", [
      req.account.id, "QR_WITH_LOGO_GENERATED", `Product: ${productData.id} - ${productData.name}`,
    ]);

    res.json({ signedToken, verifyUrl, qrDataUrl, productId: productData.id, hasLogo: !!logoBuffer });
  } catch (err) {
    console.error("❌ Sign-QR-with-Logo error:", err);
    res.status(400).json({ error: "QR generation failed: " + err.message });
  }
});

// ================================
// VERIFY TOKEN — public, customer-facing
// ================================
app.post("/verify-token", verifyLimiter, async (req, res) => {
  const { signedToken } = req.body || {};
  if (!signedToken) return res.status(400).json({ valid: false, error: "signedToken missing" });
  if (!PUBLIC_KEY) return res.status(500).json({ valid: false, error: "PUBLIC_KEY not set" });

  const ipAddress = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    const decoded = jwt.verify(signedToken, PUBLIC_KEY, { algorithms: ["RS256"] });
    const productId = decoded.data.id || "unknown";
    const accountId = decoded.data.account_id;

    if (!accountId) {
      return res.status(400).json({ valid: false, error: "Legacy token format not supported - please regenerate this QR code" });
    }

    const productCheck = await pool.query("SELECT is_active FROM products WHERE account_id = $1 AND product_id = $2", [accountId, productId]);
    const isActive = productCheck.rows.length === 0 ? true : productCheck.rows[0].is_active;

    const brandResult = await pool.query("SELECT business_name, brand_logo_url, brand_color FROM accounts WHERE id = $1", [accountId]);
    const brand = brandResult.rows[0] || {};

    const location = await lookupLocation(ipAddress);

    if (!isActive) {
      await pool.query(
        `INSERT INTO verifications (account_id, product_id, is_valid, risk_level, ip_address, user_agent, location_country, location_city, error_message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [accountId, productId, false, "high", ipAddress, userAgent, location.country, location.city, "Product deactivated"]
      );
      return res.json({ valid: false, error: "This product has been deactivated", payload: decoded.data, risk: "high" });
    }

    const risk = await calculateRiskLevel(accountId, productId);

    await pool.query(
      `INSERT INTO verifications (account_id, product_id, is_valid, risk_level, ip_address, user_agent, location_country, location_city) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accountId, productId, true, risk, ipAddress, userAgent, location.country, location.city]
    );

    const countResult = await pool.query("SELECT COUNT(*) as count FROM verifications WHERE account_id = $1 AND product_id = $2", [accountId, productId]);
    const scanCount = parseInt(countResult.rows[0].count);

    const productRow = await pool.query("SELECT inscription_id FROM products WHERE account_id = $1 AND product_id = $2", [accountId, productId]);
    const inscriptionId = productRow.rows[0]?.inscription_id || null;

    res.json({
      valid: true,
      payload: decoded.data,
      risk,
      scanCount,
      inscriptionId,
      location: location.city && location.country ? `${location.city}, ${location.country}` : null,
      brand: {
        businessName: brand.business_name || null,
        logoUrl: brand.brand_logo_url || null,
        color: brand.brand_color || "#c9a227",
      },
    });
  } catch (err) {
    console.error("❌ Verify error:", err.message);
    res.status(400).json({ valid: false, error: "Invalid or expired token", details: err.message });
  }
});

// ================================
// PRODUCTS (account-scoped)
// ================================
app.get("/products", requireAccount, accountLimiter, async (req, res) => {
  try {
    const { search, active, limit = 50, offset = 0 } = req.query;
    let query = "SELECT * FROM products WHERE account_id = $1";
    const params = [req.account.id];
    let n = 2;

    if (search) {
      query += ` AND (product_id ILIKE $${n} OR name ILIKE $${n})`;
      params.push(`%${search}%`);
      n++;
    }
    if (active !== undefined) {
      query += ` AND is_active = $${n}`;
      params.push(active === "true");
      n++;
    }
    query += ` ORDER BY created_at DESC LIMIT $${n} OFFSET $${n + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query("SELECT COUNT(*) FROM products WHERE account_id = $1", [req.account.id]);
    res.json({ products: result.rows, total: parseInt(countResult.rows[0].count), limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/products/:id", requireAccount, accountLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products WHERE account_id = $1 AND product_id = $2", [req.account.id, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

app.post("/products/:id/deactivate", requireAccount, accountLimiter, async (req, res) => {
  try {
    const result = await pool.query("UPDATE products SET is_active = false WHERE account_id = $1 AND product_id = $2 RETURNING *", [req.account.id, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    await pool.query("INSERT INTO audit_log (account_id, action, details) VALUES ($1, $2, $3)", [req.account.id, "PRODUCT_DEACTIVATED", `Product: ${req.params.id}`]);
    res.json({ message: "Product deactivated", product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to deactivate product" });
  }
});

app.post("/products/:id/activate", requireAccount, accountLimiter, async (req, res) => {
  try {
    const result = await pool.query("UPDATE products SET is_active = true WHERE account_id = $1 AND product_id = $2 RETURNING *", [req.account.id, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    await pool.query("INSERT INTO audit_log (account_id, action, details) VALUES ($1, $2, $3)", [req.account.id, "PRODUCT_ACTIVATED", `Product: ${req.params.id}`]);
    res.json({ message: "Product activated", product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to activate product" });
  }
});

// ================================
// BLOCKCHAIN INSCRIPTION (account-scoped)
// ================================
app.get("/products/:id/manifest", requireAccount, accountLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT product_id, name, batch, signed_token, notes FROM products WHERE account_id = $1 AND product_id = $2", [req.account.id, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    const p = result.rows[0];
    if (!p.signed_token) return res.status(400).json({ error: "Product has no signed token yet - generate its QR first" });

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
    res.status(500).json({ error: "Failed to build manifest" });
  }
});

app.post("/products/:id/inscription", requireAccount, accountLimiter, async (req, res) => {
  try {
    const { inscriptionId } = req.body || {};
    if (!inscriptionId || typeof inscriptionId !== "string" || inscriptionId.length > 200) {
      return res.status(400).json({ error: "inscriptionId (string) required" });
    }
    const existing = await pool.query("SELECT inscription_id FROM products WHERE account_id = $1 AND product_id = $2", [req.account.id, req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    if (existing.rows[0].inscription_id) {
      return res.status(409).json({ error: "Product already has an inscription recorded - inscriptions are permanent", current: existing.rows[0].inscription_id });
    }
    const result = await pool.query(
      "UPDATE products SET inscription_id = $3 WHERE account_id = $1 AND product_id = $2 RETURNING product_id, inscription_id",
      [req.account.id, req.params.id, inscriptionId.trim()]
    );
    await pool.query("INSERT INTO audit_log (account_id, action, details) VALUES ($1, $2, $3)", [req.account.id, "INSCRIPTION_RECORDED", `Product: ${req.params.id} → ${inscriptionId.trim()}`]);
    res.json({ message: "Inscription recorded", product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to record inscription" });
  }
});

// ================================
// VERIFICATIONS (account-scoped)
// ================================
app.get("/verifications", requireAccount, accountLimiter, async (req, res) => {
  try {
    const { product_id, risk, limit = 100, offset = 0 } = req.query;
    let query = "SELECT * FROM verifications WHERE account_id = $1";
    const params = [req.account.id];
    let n = 2;
    if (product_id) { query += ` AND product_id = $${n}`; params.push(product_id); n++; }
    if (risk) { query += ` AND risk_level = $${n}`; params.push(risk); n++; }
    query += ` ORDER BY verified_at DESC LIMIT $${n} OFFSET $${n + 1}`;
    params.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(query, params);
    res.json({ verifications: result.rows, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch verifications" });
  }
});

app.get("/analytics/overview", requireAccount, accountLimiter, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE account_id = $1) as total_products,
        (SELECT COUNT(*) FROM products WHERE account_id = $1 AND is_active = true) as active_products,
        (SELECT COUNT(*) FROM verifications WHERE account_id = $1) as total_verifications,
        (SELECT COUNT(*) FROM verifications WHERE account_id = $1 AND verified_at > NOW() - INTERVAL '24 hours') as verifications_today,
        (SELECT COUNT(*) FROM verifications WHERE account_id = $1 AND risk_level = 'high') as high_risk_verifications,
        (SELECT COUNT(*) FROM products WHERE account_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)) as used_this_month`,
      [req.account.id]
    );
    res.json({ ...stats.rows[0], planLimit: req.account.plan_product_limit, plan: req.account.plan });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

app.get("/analytics/by-date", requireAccount, accountLimiter, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const safeDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    const result = await pool.query(
      `SELECT DATE(verified_at) as date, COUNT(*) as total_verifications,
              COUNT(CASE WHEN risk_level = 'low' THEN 1 END) as low_risk,
              COUNT(CASE WHEN risk_level = 'medium' THEN 1 END) as medium_risk,
              COUNT(CASE WHEN risk_level = 'high' THEN 1 END) as high_risk
       FROM verifications
       WHERE account_id = $1 AND verified_at > CURRENT_DATE - ($2 || ' days')::INTERVAL
       GROUP BY DATE(verified_at) ORDER BY date ASC`,
      [req.account.id, safeDays]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

app.get("/analytics/by-product", requireAccount, accountLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.product_id, p.name, COUNT(v.id) as verification_count
       FROM products p
       LEFT JOIN verifications v ON p.account_id = v.account_id AND p.product_id = v.product_id
       WHERE p.account_id = $1
       GROUP BY p.product_id, p.name
       ORDER BY verification_count DESC LIMIT 20`,
      [req.account.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch product analytics" });
  }
});

// ================================
// EXPORTS
// ================================
function toCSV(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    if (val === null || val === undefined) return "";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
}

// Per-customer export of their own data
app.get("/export/products", requireAccount, exportLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products WHERE account_id = $1 ORDER BY created_at ASC", [req.account.id]);
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="products-backup-${Date.now()}.csv"`);
      return res.send(toCSV(result.rows));
    }
    res.json({ exportedAt: new Date().toISOString(), count: result.rows.length, products: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to export products" });
  }
});

app.get("/export/verifications", requireAccount, exportLimiter, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM verifications WHERE account_id = $1 ORDER BY verified_at ASC", [req.account.id]);
    if (req.query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="verifications-backup-${Date.now()}.csv"`);
      return res.send(toCSV(result.rows));
    }
    res.json({ exportedAt: new Date().toISOString(), count: result.rows.length, verifications: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to export verifications" });
  }
});

// Platform-level full backup across ALL accounts (you, not customers)
app.get("/admin/export/all", requireSuperAdmin, exportLimiter, async (req, res) => {
  if (!checkExportKey(req, res)) return;
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY account_id, created_at ASC");
    res.json({ exportedAt: new Date().toISOString(), count: result.rows.length, products: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to export" });
  }
});

// ================================
// START SERVER
// ================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`🔐 Multi-tenant auth: each account uses its own x-api-key`);

  if (!PRIVATE_KEY || !PUBLIC_KEY) console.warn(`⚠️  WARNING: Signing keys not set!`);
  else console.log(`✅ Cryptographic keys loaded`);

  if (!process.env.DATABASE_URL) console.error(`❌ DATABASE_URL not set!`);

  if (!ADMIN_KEY) console.warn(`⚠️  ADMIN_KEY not set - platform superadmin endpoints disabled`);
  if (!EXPORT_KEY) console.warn(`⚠️  EXPORT_KEY not set - platform-wide backup export disabled`);
  if (!stripe) console.warn(`⚠️  STRIPE_SECRET_KEY not set - billing endpoints disabled`);
  else if (!STRIPE_WEBHOOK_SECRET) console.warn(`⚠️  STRIPE_WEBHOOK_SECRET not set - webhook verification will fail`);
  else console.log(`✅ Stripe billing configured`);

  if (!BREVO_API_KEY) console.warn(`⚠️  BREVO_API_KEY not set - verification/reset emails will be logged, not sent`);
  else console.log(`✅ Email service configured (sending as ${EMAIL_FROM_NAME} <${EMAIL_FROM}>)`);
});
