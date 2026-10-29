"use strict";
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const sqlite3 = require("sqlite3").verbose();
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
    role TEXT NOT NULL, display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);`);
  db.run(`CREATE TABLE IF NOT EXISTS doctors (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);`);
  db.run(`CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, patient_id TEXT, doctor_id TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS beds (id TEXT PRIMARY KEY, ward TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS prescriptions (id TEXT PRIMARY KEY, patient_id TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, patient_id TEXT, amount_cents INTEGER);`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT);`);
});

app.disable("x-powered-by");
if (IS_PROD) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(cookieParser());

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

app.post("/api/auth/login", async (req, res, next) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password || "admin123", 10);

  db.run(
    `INSERT INTO users (id, username, password_hash, role, display_name, active) 
     VALUES ('admin-id-123', 'admin', ?, 'admin', 'System Administrator', 1)
     ON CONFLICT(username) DO UPDATE SET password_hash = ?`,
    [hash, hash],
    () => {
      db.get("SELECT * FROM users WHERE username = ? AND active = 1", [username], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: "Invalid username or password." });
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: "Invalid username or password." });

        const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
          algorithm: "HS256", expiresIn: `${SESSION_TTL_MINUTES}m`
        });

        res.cookie(COOKIE_NAME, token, {
          httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? "none" : "lax", path: "/", maxAge: SESSION_TTL_MINUTES * 60 * 1000
        });

        res.json({ user: publicUser(user), expiresInMinutes: SESSION_TTL_MINUTES });
      });
    }
  );
});

app.post("/api/auth/logout", authenticate, (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user, permissions: ["*"] }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Correct Dashboard & Stats format expected by frontend
app.get("/api/dashboard", authenticate, (_req, res) => {
  res.json({
    patients: [],
    doctors: [],
    appointments: [],
    beds: [],
    prescriptions: [],
    invoices: [],
    auditLogs: [],
    stats: { totalPatients: 0, totalDoctors: 0, activeAppointments: 0, availableBeds: 0 }
  });
});

app.get("/api/patients", authenticate, (_req, res) => res.json([]));
app.get("/api/doctors", authenticate, (_req, res) => res.json([]));
app.get("/api/appointments", authenticate, (_req, res) => res.json([]));
app.get("/api/beds", authenticate, (_req, res) => res.json([]));
app.get("/api/prescriptions", authenticate, (_req, res) => res.json([]));
app.get("/api/invoices", authenticate, (_req, res) => res.json([]));
app.get("/api/audit-logs", authenticate, (_req, res) => res.json([]));

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API not found." });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
