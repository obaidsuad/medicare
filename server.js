"use strict";
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const sqlite3 = require("sqlite3").verbose();
const { z } = require("zod");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const IS_PROD = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const COOKIE_NAME = "medicare_session";
const SESSION_TTL_MINUTES = Math.max(5, Math.min(240, Number(process.env.SESSION_TTL_MINUTES || 30)));
const JWT_SECRET = process.env.JWT_SECRET || "";
const DB_PATH = path.resolve(process.env.DB_PATH || "./data/medicare.sqlite");

if (JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET must be at least 32 characters.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','doctor','nurse','receptionist','accountant')),
    display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, date_of_birth TEXT, gender TEXT,
    phone TEXT, email TEXT, address TEXT, blood_group TEXT, allergies TEXT,
    emergency_contact TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'Outpatient',
    doctor_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS doctors (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, specialty TEXT NOT NULL,
    phone TEXT, email TEXT, room TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, doctor_id TEXT NOT NULL,
    appointment_at TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Scheduled',
    notes TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS beds (
    id TEXT PRIMARY KEY, ward TEXT NOT NULL, bed_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Available', patient_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS prescriptions (
    id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, doctor_id TEXT NOT NULL,
    medication TEXT NOT NULL, dosage TEXT NOT NULL, frequency TEXT NOT NULL,
    duration TEXT NOT NULL, instructions TEXT, created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Unpaid',
    due_date TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_username TEXT,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
    ip_hash TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);

  db.get("SELECT COUNT(*) AS n FROM users", (err, row) => {
    if (!err && row && row.n === 0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
      db.run("INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, 'admin', ?)",
        [crypto.randomUUID(), process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD_HASH, "System Administrator"]);
    }
  });
});

app.disable("x-powered-by");
if (IS_PROD) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "32kb", strict: true }));
app.use(cookieParser());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 200, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/api", apiLimiter);

const roles = {
  admin: ["*"],
  doctor: ["dashboard:read","patients:read","patients:write","doctors:read","appointments:read","appointments:write","prescriptions:read","prescriptions:write","beds:read","invoices:read"],
  nurse: ["dashboard:read","patients:read","patients:write","doctors:read","appointments:read","beds:read","beds:write"],
  receptionist: ["dashboard:read","patients:read","patients:write","doctors:read","appointments:read","appointments:write","beds:read","invoices:read","invoices:write"],
  accountant: ["dashboard:read","patients:read","invoices:read","invoices:write"]
};
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, displayName: u.display_name });

function authenticate(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Please sign in." });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    db.get("SELECT id, username, role, display_name, active FROM users WHERE id = ?", [payload.sub], (err, user) => {
      if (err || !user || !user.active) return res.status(401).json({ error: "Session invalid." });
      req.user = publicUser(user);
      next();
    });
  } catch (_) { return res.status(401).json({ error: "Session expired." }); }
}

// Fixed Login Route with flexible cookie settings for Render HTTPS
app.post("/api/auth/login", loginLimiter, (req, res, next) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ? AND active = 1", [username], async (err, user) => {
    if (err) return next(err);
    const valid = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid");
    if (!user || !valid) {
      return res.status(401).json({ error: "Invalid username or password." });
    }
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
      algorithm: "HS256", expiresIn: `${SESSION_TTL_MINUTES}m`
    });
    
    // Flexible cookie config so it works seamlessly on Render HTTPS
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? "none" : "lax",
      path: "/",
      maxAge: SESSION_TTL_MINUTES * 60 * 1000
    });
    
    res.json({ user: publicUser(user), expiresInMinutes: SESSION_TTL_MINUTES });
  });
});

app.post("/api/auth/logout", authenticate, (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? "none" : "lax", path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user, permissions: roles[req.user.role] || [] }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "MediCare Pro" }));

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API not found." });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`MediCare Pro running on port ${PORT}`));
