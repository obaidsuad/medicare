"use strict";
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const IS_PROD = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const COOKIE_NAME = "medicare_session";
const SESSION_TTL_MINUTES = 60;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretjwtkeythatmustbeatleast32charslong!";
const DB_PATH = path.resolve("./data/medicare.sqlite");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','doctor','nurse','receptionist','accountant')),
    display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);`);
  db.run(`CREATE TABLE IF NOT EXISTS doctors (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);`);
  db.run(`CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, patient_id TEXT, doctor_id TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS beds (id TEXT PRIMARY KEY, ward TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS prescriptions (id TEXT PRIMARY KEY, patient_id TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, patient_id TEXT, amount_cents INTEGER);`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT);`);

  // Default Admin User: admin / admin123
  const defaultAdminUser = process.env.ADMIN_USERNAME || "admin";
  const defaultPasswordHash = process.env.ADMIN_PASSWORD_HASH || "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/kJ0Wv2Q.K"; // admin123

  db.get("SELECT COUNT(*) AS n FROM users", (err, row) => {
    if (!err && row && row.n === 0) {
      db.run("INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, 'admin', ?)",
        [crypto.randomUUID(), defaultAdminUser, defaultPasswordHash, "System Administrator"]);
    }
  });
});

app.disable("x-powered-by");
if (IS_PROD) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(cookieParser());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 200, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/api", apiLimiter);

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

// Full Secure Login Route
app.post("/api/auth/login", loginLimiter, (req, res, next) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ? AND active = 1", [username], async (err, user) => {
    if (err) return next(err);
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !valid) {
      return res.status(401).json({ error: "Invalid username or password." });
    }
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
      algorithm: "HS256", expiresIn: `${SESSION_TTL_MINUTES}m`
    });

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

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user, permissions: ["*"] }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API not found." });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`MediCare Pro running on port ${PORT}`));
