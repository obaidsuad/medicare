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
const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_NAME = "medicare_session";
const SESSION_TTL_MINUTES = Math.max(5, Math.min(240, Number(process.env.SESSION_TTL_MINUTES || 30)));
const JWT_SECRET = process.env.JWT_SECRET || "";
const APP_ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const DB_PATH = path.resolve(process.env.DB_PATH || "./data/medicare.sqlite");

if (JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET must be at least 32 characters. Set it in .env.");
  process.exit(1);
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH ||
    !/^\$2[aby]\$/.test(process.env.ADMIN_PASSWORD_HASH)) {
  console.error("FATAL: Set ADMIN_USERNAME and a bcrypt ADMIN_PASSWORD_HASH in .env.");
  process.exit(1);
}
if (IS_PROD && process.env.COOKIE_SECURE !== "true") {
  console.error("FATAL: COOKIE_SECURE=true is required in production (serve behind HTTPS).");
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','doctor','nurse','receptionist','accountant')),
    display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, date_of_birth TEXT, gender TEXT,
    phone TEXT, email TEXT, address TEXT, blood_group TEXT, allergies TEXT,
    emergency_contact TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'Outpatient',
    doctor_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS doctors (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, specialty TEXT NOT NULL,
    phone TEXT, email TEXT, room TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
    doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
    appointment_at TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Scheduled',
    notes TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS beds (
    id TEXT PRIMARY KEY, ward TEXT NOT NULL, bed_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','Occupied','Maintenance')),
    patient_id TEXT REFERENCES patients(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS prescriptions (
    id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
    doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
    medication TEXT NOT NULL, dosage TEXT NOT NULL, frequency TEXT NOT NULL,
    duration TEXT NOT NULL, instructions TEXT, created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
    description TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    status TEXT NOT NULL DEFAULT 'Unpaid' CHECK(status IN ('Unpaid','Paid','Cancelled')),
    due_date TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
  db.run(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_username TEXT,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
    ip_hash TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);
});

app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], frameAncestors: ["'none'"],
      objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], formAction: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: "32kb", strict: true }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "MediCare Pro", time: new Date().toISOString() }));

app.use(express.static(path.join(__dirname,"public"), { index:"index.html", etag:true, maxAge: IS_PROD ? "1h" : 0 }));
app.get("*", (req,res) => {
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"API endpoint not found."});
  res.sendFile(path.join(__dirname,"public","index.html"));
});

const server=app.listen(PORT,()=>console.log(`MediCare Pro running at ${APP_ORIGIN} (port ${PORT})`));
function shutdown() {
  server.close(()=>{ db.close(); process.exit(0); });
  setTimeout(()=>process.exit(1),5000).unref();
}
process.on("SIGINT",shutdown);
process.on("SIGTERM",shutdown);
