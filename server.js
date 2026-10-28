"use strict";
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
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
const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch (_) {}
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','doctor','nurse','receptionist','accountant')),
  display_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, date_of_birth TEXT, gender TEXT,
  phone TEXT, email TEXT, address TEXT, blood_group TEXT, allergies TEXT,
  emergency_contact TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'Outpatient',
  doctor_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, specialty TEXT NOT NULL,
  phone TEXT, email TEXT, room TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  appointment_at TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Scheduled',
  notes TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS beds (
  id TEXT PRIMARY KEY, ward TEXT NOT NULL, bed_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','Occupied','Maintenance')),
  patient_id TEXT REFERENCES patients(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS prescriptions (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  medication TEXT NOT NULL, dosage TEXT NOT NULL, frequency TEXT NOT NULL,
  duration TEXT NOT NULL, instructions TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  description TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'Unpaid' CHECK(status IN ('Unpaid','Paid','Cancelled')),
  due_date TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_username TEXT,
  action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
  ip_hash TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
`);

const countUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
if (countUsers === 0) {
  db.prepare(`INSERT INTO users (id, username, password_hash, role, display_name)
    VALUES (?, ?, ?, 'admin', ?)`).run(crypto.randomUUID(), process.env.ADMIN_USERNAME,
      process.env.ADMIN_PASSWORD_HASH, "System Administrator");
}
const doctorCount = db.prepare("SELECT COUNT(*) AS n FROM doctors").get().n;
if (doctorCount === 0) {
  const addDoctor = db.prepare("INSERT INTO doctors (id, full_name, specialty, phone, email, room) VALUES (?, ?, ?, ?, ?, ?)");
  const seed = db.transaction(() => {
    [
      ["Dr. Sarah Khan", "Cardiology", "0100000001", "sarah@example.invalid", "C-101"],
      ["Dr. Ariful Islam", "Neurology", "0100000002", "ariful@example.invalid", "N-202"],
      ["Dr. Farhana Haq", "Gynecology", "0100000003", "farhana@example.invalid", "G-103"],
      ["Dr. Subhash Bose", "Orthopedics", "0100000004", "subhash@example.invalid", "O-104"]
    ].forEach(d => addDoctor.run(crypto.randomUUID(), ...d));
  });
  seed();
}
const bedCount = db.prepare("SELECT COUNT(*) AS n FROM beds").get().n;
if (bedCount === 0) {
  const addBed = db.prepare("INSERT INTO beds (id, ward, bed_type, status) VALUES (?, ?, ?, 'Available')");
  const seedBeds = db.transaction(() => {
    for (let i = 1; i <= 8; i++) addBed.run(`GEN-${String(i).padStart(2,"0")}`, "General Ward", "General");
    for (let i = 1; i <= 4; i++) addBed.run(`ICU-${String(i).padStart(2,"0")}`, "ICU", "Critical Care");
    for (let i = 1; i <= 6; i++) addBed.run(`CAB-${String(400+i)}`, "Cabin", "Private");
  });
  seedBeds();
}

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
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use((req, res, next) => {
  if (req.method === "GET" || req.path === "/api/auth/login" || req.path === "/api/health") return next();
  const origin = req.get("origin");
  if (origin && origin !== APP_ORIGIN) return res.status(403).json({ error: "Origin not allowed." });
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." } });
app.use("/api", apiLimiter);

const roles = {
  admin: ["*"],
  doctor: ["dashboard:read","patients:read","patients:write","doctors:read","appointments:read","appointments:write","prescriptions:read","prescriptions:write","beds:read","invoices:read"],
  nurse: ["dashboard:read","patients:read","patients:write","doctors:read","appointments:read","beds:read","beds:write"],
  receptionist: ["dashboard:read","patients:read","patients:write","doctors:read","appointments:read","appointments:write","beds:read","invoices:read","invoices:write"],
  accountant: ["dashboard:read","patients:read","invoices:read","invoices:write"]
};
const id = () => crypto.randomUUID();
const clean = value => typeof value === "string" ? value.trim() : value;
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, displayName: u.display_name });
function audit(req, action, entityType, entityId, details = {}) {
  const actor = req.user || {};
  const ipHash = crypto.createHash("sha256").update(String(req.ip || "") + (process.env.AUDIT_IP_SALT || "medicare-demo")).digest("hex").slice(0, 24);
  db.prepare(`INSERT INTO audit_logs (actor_id, actor_username, action, entity_type, entity_id, ip_hash, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(actor.id || null, actor.username || null, action, entityType,
      entityId || null, ipHash, JSON.stringify(details));
}
function authenticate(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Please sign in." });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"], issuer: "medicare-pro", audience: "medicare-pro-users" });
    const user = db.prepare("SELECT id, username, role, display_name, active FROM users WHERE id = ?").get(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: "Session is no longer valid." });
    req.user = { ...publicUser(user) };
    next();
  } catch (_) { return res.status(401).json({ error: "Session expired or invalid. Please sign in again." }); }
}
function requirePermission(permission) {
  return (req, res, next) => {
    const allowed = roles[req.user.role] || [];
    if (!allowed.includes("*") && !allowed.includes(permission)) return res.status(403).json({ error: "You do not have permission to perform this action." });
    next();
  };
}
function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return res.status(400).json({ error: "Please check the submitted fields.", issues: result.error.issues.map(i => ({ field: i.path.join("."), message: i.message })) });
    req[source] = result.data;
    next();
  };
}
const str = (min=1,max=160) => z.string().trim().min(min).max(max);
const optionalText = (max=500) => z.string().trim().max(max).optional().or(z.literal(""));
const patientSchema = z.object({
  full_name: str(2,120), date_of_birth: optionalText(10), gender: z.enum(["Female","Male","Other","Prefer not to say"]).optional(),
  phone: optionalText(30), email: z.union([z.string().email().max(160), z.literal("")]).optional(),
  address: optionalText(300), blood_group: z.enum(["A+","A-","B+","B-","AB+","AB-","O+","O-","Unknown"]).optional(),
  allergies: optionalText(500), emergency_contact: optionalText(120), notes: optionalText(1000),
  status: z.enum(["Outpatient","Admitted","In Consultation","Discharged"]).default("Outpatient"),
  doctor_id: optionalText(60)
}).strict();
const appointmentSchema = z.object({
  patient_id: str(1,60), doctor_id: str(1,60), appointment_at: z.string().datetime({ offset: true }),
  reason: str(2,300), status: z.enum(["Scheduled","Checked In","Completed","Cancelled"]).default("Scheduled"),
  notes: optionalText(1000)
}).strict();
const prescriptionSchema = z.object({
  patient_id: str(1,60), doctor_id: str(1,60), medication: str(2,160), dosage: str(1,100),
  frequency: str(1,100), duration: str(1,100), instructions: optionalText(1000)
}).strict();
const invoiceSchema = z.object({
  patient_id: str(1,60), description: str(2,240),
  amount: z.number().finite().min(0).max(100000000), status: z.enum(["Unpaid","Paid","Cancelled"]).default("Unpaid"),
  due_date: optionalText(10)
}).strict();
const bedSchema = z.object({
  status: z.enum(["Available","Occupied","Maintenance"]), patient_id: optionalText(60)
}).strict();

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "MediCare Pro", time: new Date().toISOString() }));
app.post("/api/auth/login", loginLimiter, validate(z.object({ username: str(1,100), password: str(1,200) }).strict()), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username);
    const valid = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid");
    if (!user || !valid) {
      audit({ ...req, user: null }, "LOGIN_FAILED", "user", null, { username: username.slice(0, 80) });
      return res.status(401).json({ error: "Invalid username or password." });
    }
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
      algorithm: "HS256", expiresIn: `${SESSION_TTL_MINUTES}m`, issuer: "medicare-pro", audience: "medicare-pro-users"
    });
    res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: IS_PROD || process.env.COOKIE_SECURE === "true", sameSite: "strict", path: "/", maxAge: SESSION_TTL_MINUTES * 60 * 1000 });
    req.user = publicUser(user);
    audit(req, "LOGIN_SUCCESS", "user", user.id);
    res.json({ user: publicUser(user), expiresInMinutes: SESSION_TTL_MINUTES });
  } catch (e) { next(e); }
});
app.post("/api/auth/logout", authenticate, (req, res) => {
  audit(req, "LOGOUT", "user", req.user.id);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD || process.env.COOKIE_SECURE === "true", sameSite: "strict", path: "/" });
  res.json({ ok: true });
});
app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user, permissions: roles[req.user.role] || [] }));

app.get("/api/dashboard", authenticate, requirePermission("dashboard:read"), (req, res) => {
  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const upcoming = db.prepare(`SELECT a.id,a.appointment_at,a.reason,a.status,p.full_name AS patient_name,d.full_name AS doctor_name
    FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN doctors d ON d.id=a.doctor_id
    WHERE a.status IN ('Scheduled','Checked In') ORDER BY a.appointment_at LIMIT 6`).all();
  const revenue = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM invoices WHERE status='Paid'").get().cents;
  const unpaid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM invoices WHERE status='Unpaid'").get().cents;
  res.json({ metrics: { patients: count("patients"), doctors: db.prepare("SELECT COUNT(*) AS n FROM doctors WHERE active=1").get().n,
    appointmentsToday: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date(appointment_at)=date('now') AND status!='Cancelled'").get().n,
    availableBeds: db.prepare("SELECT COUNT(*) AS n FROM beds WHERE status='Available'").get().n,
    occupiedBeds: db.prepare("SELECT COUNT(*) AS n FROM beds WHERE status='Occupied'").get().n,
    paidRevenueCents: revenue, unpaidCents: unpaid }, upcoming });
});

app.get("/api/patients", authenticate, requirePermission("patients:read"), (req, res) => {
  const q = String(req.query.q || "").slice(0,100);
  const status = String(req.query.status || "");
  const rows = db.prepare(`SELECT p.id,p.full_name,p.date_of_birth,p.gender,p.phone,p.email,p.address,p.blood_group,p.allergies,
    p.emergency_contact,p.notes,p.status,p.doctor_id,p.created_at,p.updated_at,d.full_name AS doctor_name
    FROM patients p LEFT JOIN doctors d ON d.id=p.doctor_id
    WHERE (p.full_name LIKE ? OR p.phone LIKE ? OR p.id LIKE ?) AND (?='' OR p.status=?)
    ORDER BY p.created_at DESC LIMIT 250`).all(`%${q}%`,`%${q}%`,`%${q}%`,status,status);
  res.json({ patients: rows });
});
app.post("/api/patients", authenticate, requirePermission("patients:write"), validate(patientSchema), (req,res) => {
  const p = req.body, patientId = `PT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  if (p.doctor_id && !db.prepare("SELECT id FROM doctors WHERE id=? AND active=1").get(p.doctor_id)) return res.status(400).json({ error: "Selected doctor does not exist." });
  db.prepare(`INSERT INTO patients (id,full_name,date_of_birth,gender,phone,email,address,blood_group,allergies,emergency_contact,notes,status,doctor_id)
    VALUES (@id,@full_name,@date_of_birth,@gender,@phone,@email,@address,@blood_group,@allergies,@emergency_contact,@notes,@status,@doctor_id)`)
    .run({ id:patientId, full_name:p.full_name, date_of_birth:p.date_of_birth||null, gender:p.gender||null, phone:p.phone||null,
      email:p.email||null, address:p.address||null, blood_group:p.blood_group||null, allergies:p.allergies||null,
      emergency_contact:p.emergency_contact||null, notes:p.notes||null, status:p.status, doctor_id:p.doctor_id||null });
  audit(req,"CREATE","patient",patientId,{});
  res.status(201).json({ patient: db.prepare("SELECT * FROM patients WHERE id=?").get(patientId) });
});
app.put("/api/patients/:id", authenticate, requirePermission("patients:write"), validate(patientSchema), (req,res) => {
  const p=req.body;
  if (!db.prepare("SELECT id FROM patients WHERE id=?").get(req.params.id)) return res.status(404).json({error:"Patient not found."});
  if (p.doctor_id && !db.prepare("SELECT id FROM doctors WHERE id=? AND active=1").get(p.doctor_id)) return res.status(400).json({error:"Selected doctor does not exist."});
  db.prepare(`UPDATE patients SET full_name=@full_name,date_of_birth=@date_of_birth,gender=@gender,phone=@phone,email=@email,address=@address,
    blood_group=@blood_group,allergies=@allergies,emergency_contact=@emergency_contact,notes=@notes,status=@status,doctor_id=@doctor_id,updated_at=CURRENT_TIMESTAMP WHERE id=@id`)
    .run({id:req.params.id,full_name:p.full_name,date_of_birth:p.date_of_birth||null,gender:p.gender||null,phone:p.phone||null,email:p.email||null,
      address:p.address||null,blood_group:p.blood_group||null,allergies:p.allergies||null,emergency_contact:p.emergency_contact||null,
      notes:p.notes||null,status:p.status,doctor_id:p.doctor_id||null});
  audit(req,"UPDATE","patient",req.params.id,{});
  res.json({patient:db.prepare("SELECT * FROM patients WHERE id=?").get(req.params.id)});
});
app.delete("/api/patients/:id", authenticate, requirePermission("patients:write"), (req,res) => {
  try {
    const row=db.prepare("SELECT id FROM patients WHERE id=?").get(req.params.id);
    if(!row) return res.status(404).json({error:"Patient not found."});
    db.prepare("DELETE FROM patients WHERE id=?").run(req.params.id);
    audit(req,"DELETE","patient",req.params.id,{});
    res.json({ok:true});
  } catch (_) { res.status(409).json({error:"Patient has linked records and cannot be deleted. Update the record status instead."}); }
});

app.get("/api/doctors", authenticate, requirePermission("doctors:read"), (req,res) => {
  res.json({doctors:db.prepare("SELECT id,full_name,specialty,phone,email,room,active,created_at FROM doctors ORDER BY full_name").all()});
});
app.post("/api/doctors", authenticate, requirePermission("admin:manage"), validate(z.object({
  full_name:str(2,120), specialty:str(2,100), phone:optionalText(30), email:z.union([z.string().email().max(160),z.literal("")]).optional(), room:optionalText(40)
}).strict()), (req,res) => {
  const d={id:`DR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,...req.body};
  db.prepare("INSERT INTO doctors (id,full_name,specialty,phone,email,room) VALUES (@id,@full_name,@specialty,@phone,@email,@room)")
    .run({...d,phone:d.phone||null,email:d.email||null,room:d.room||null});
  audit(req,"CREATE","doctor",d.id,{});
  res.status(201).json({doctor:db.prepare("SELECT * FROM doctors WHERE id=?").get(d.id)});
});

app.get("/api/appointments", authenticate, requirePermission("appointments:read"), (req,res) => {
  res.json({appointments:db.prepare(`SELECT a.*,p.full_name AS patient_name,d.full_name AS doctor_name FROM appointments a
    JOIN patients p ON p.id=a.patient_id JOIN doctors d ON d.id=a.doctor_id ORDER BY a.appointment_at DESC LIMIT 300`).all()});
});
app.post("/api/appointments", authenticate, requirePermission("appointments:write"), validate(appointmentSchema), (req,res) => {
  const a=req.body;
  if(!db.prepare("SELECT id FROM patients WHERE id=?").get(a.patient_id)) return res.status(400).json({error:"Patient does not exist."});
  if(!db.prepare("SELECT id FROM doctors WHERE id=? AND active=1").get(a.doctor_id)) return res.status(400).json({error:"Doctor does not exist."});
  const aid=`AP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  db.prepare("INSERT INTO appointments (id,patient_id,doctor_id,appointment_at,reason,status,notes,created_by) VALUES (@id,@patient_id,@doctor_id,@appointment_at,@reason,@status,@notes,@created_by)")
    .run({...a,id:aid,created_by:req.user.id,notes:a.notes||null});
  audit(req,"CREATE","appointment",aid,{});
  res.status(201).json({appointment:db.prepare("SELECT * FROM appointments WHERE id=?").get(aid)});
});
app.patch("/api/appointments/:id/status", authenticate, requirePermission("appointments:write"), validate(z.object({status:z.enum(["Scheduled","Checked In","Completed","Cancelled"])}).strict()), (req,res) => {
  const exists=db.prepare("SELECT id FROM appointments WHERE id=?").get(req.params.id);
  if(!exists) return res.status(404).json({error:"Appointment not found."});
  db.prepare("UPDATE appointments SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.status,req.params.id);
  audit(req,"UPDATE_STATUS","appointment",req.params.id,{status:req.body.status});
  res.json({ok:true});
});

app.get("/api/beds", authenticate, requirePermission("beds:read"), (req,res) => {
  res.json({beds:db.prepare(`SELECT b.*,p.full_name AS patient_name FROM beds b LEFT JOIN patients p ON p.id=b.patient_id ORDER BY b.ward,b.id`).all()});
});
app.patch("/api/beds/:id", authenticate, requirePermission("beds:write"), validate(bedSchema), (req,res) => {
  const b=req.body;
  if(!db.prepare("SELECT id FROM beds WHERE id=?").get(req.params.id)) return res.status(404).json({error:"Bed not found."});
  if(b.status==="Occupied" && !b.patient_id) return res.status(400).json({error:"Choose a patient before marking a bed occupied."});
  if(b.patient_id && !db.prepare("SELECT id FROM patients WHERE id=?").get(b.patient_id)) return res.status(400).json({error:"Patient does not exist."});
  db.prepare("UPDATE beds SET status=?,patient_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(b.status,b.status==="Occupied"?(b.patient_id||null):null,req.params.id);
  audit(req,"UPDATE","bed",req.params.id,{status:b.status});
  res.json({bed:db.prepare("SELECT * FROM beds WHERE id=?").get(req.params.id)});
});

app.get("/api/prescriptions", authenticate, requirePermission("prescriptions:read"), (req,res) => {
  res.json({prescriptions:db.prepare(`SELECT r.*,p.full_name AS patient_name,d.full_name AS doctor_name FROM prescriptions r
    JOIN patients p ON p.id=r.patient_id JOIN doctors d ON d.id=r.doctor_id ORDER BY r.created_at DESC LIMIT 250`).all()});
});
app.post("/api/prescriptions", authenticate, requirePermission("prescriptions:write"), validate(prescriptionSchema), (req,res) => {
  if(req.user.role!=="admin" && req.user.role!=="doctor") return res.status(403).json({error:"Only doctors or administrators can create prescriptions."});
  const p=req.body;
  if(!db.prepare("SELECT id FROM patients WHERE id=?").get(p.patient_id)) return res.status(400).json({error:"Patient does not exist."});
  if(!db.prepare("SELECT id FROM doctors WHERE id=? AND active=1").get(p.doctor_id)) return res.status(400).json({error:"Doctor does not exist."});
  const pid=`RX-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  db.prepare("INSERT INTO prescriptions (id,patient_id,doctor_id,medication,dosage,frequency,duration,instructions,created_by) VALUES (@id,@patient_id,@doctor_id,@medication,@dosage,@frequency,@duration,@instructions,@created_by)")
    .run({...p,id:pid,created_by:req.user.id,instructions:p.instructions||null});
  audit(req,"CREATE","prescription",pid,{});
  res.status(201).json({prescription:db.prepare("SELECT * FROM prescriptions WHERE id=?").get(pid)});
});

app.get("/api/invoices", authenticate, requirePermission("invoices:read"), (req,res) => {
  res.json({invoices:db.prepare(`SELECT i.*,p.full_name AS patient_name FROM invoices i JOIN patients p ON p.id=i.patient_id ORDER BY i.created_at DESC LIMIT 300`).all()});
});
app.post("/api/invoices", authenticate, requirePermission("invoices:write"), validate(invoiceSchema), (req,res) => {
  const i=req.body;
  if(!db.prepare("SELECT id FROM patients WHERE id=?").get(i.patient_id)) return res.status(400).json({error:"Patient does not exist."});
  const iid=`INV-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  db.prepare("INSERT INTO invoices (id,patient_id,description,amount_cents,status,due_date,created_by) VALUES (@id,@patient_id,@description,@amount_cents,@status,@due_date,@created_by)")
    .run({id:iid,patient_id:i.patient_id,description:i.description,amount_cents:Math.round(i.amount*100),status:i.status,due_date:i.due_date||null,created_by:req.user.id});
  audit(req,"CREATE","invoice",iid,{amount_cents:Math.round(i.amount*100)});
  res.status(201).json({invoice:db.prepare("SELECT * FROM invoices WHERE id=?").get(iid)});
});
app.patch("/api/invoices/:id/status", authenticate, requirePermission("invoices:write"), validate(z.object({status:z.enum(["Paid","Unpaid","Cancelled"])}).strict()), (req,res) => {
  const exists=db.prepare("SELECT id FROM invoices WHERE id=?").get(req.params.id);
  if(!exists) return res.status(404).json({error:"Invoice not found."});
  db.prepare("UPDATE invoices SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.status,req.params.id);
  audit(req,"UPDATE_STATUS","invoice",req.params.id,{status:req.body.status});
  res.json({ok:true});
});

app.get("/api/audit-logs", authenticate, requirePermission("admin:manage"), (req,res) => {
  res.json({logs:db.prepare("SELECT id,actor_username,action,entity_type,entity_id,ip_hash,details,created_at FROM audit_logs ORDER BY id DESC LIMIT 200").all()});
});
app.get("/api/users", authenticate, requirePermission("admin:manage"), (req,res) => {
  res.json({users:db.prepare("SELECT id,username,role,display_name,active,created_at FROM users ORDER BY created_at DESC").all()});
});
app.post("/api/users", authenticate, requirePermission("admin:manage"), validate(z.object({
  username:z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  password:z.string().min(12).max(200), role:z.enum(["admin","doctor","nurse","receptionist","accountant"]),
  display_name:str(2,120)
}).strict()), async (req,res,next) => {
  try {
    const {username,password,role,display_name}=req.body;
    if(db.prepare("SELECT id FROM users WHERE username=?").get(username)) return res.status(409).json({error:"Username already exists."});
    const hash=await bcrypt.hash(password,12), uid=id();
    db.prepare("INSERT INTO users (id,username,password_hash,role,display_name) VALUES (?,?,?,?,?)").run(uid,username,hash,role,display_name);
    audit(req,"CREATE","user",uid,{role});
    res.status(201).json({user:{id:uid,username,role,displayName:display_name}});
  } catch(e) { next(e); }
});
app.patch("/api/users/:id/active", authenticate, requirePermission("admin:manage"), validate(z.object({active:z.boolean()}).strict()), (req,res) => {
  if(req.params.id===req.user.id && !req.body.active) return res.status(400).json({error:"You cannot deactivate your own account."});
  const result=db.prepare("UPDATE users SET active=? WHERE id=?").run(req.body.active?1:0,req.params.id);
  if(!result.changes) return res.status(404).json({error:"User not found."});
  audit(req,"UPDATE_ACTIVE","user",req.params.id,{active:req.body.active});
  res.json({ok:true});
});

app.use(express.static(path.join(__dirname,"public"), { index:"index.html", etag:true, maxAge: IS_PROD ? "1h" : 0 }));
app.get("*", (req,res) => {
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"API endpoint not found."});
  res.sendFile(path.join(__dirname,"public","index.html"));
});
app.use((err,req,res,_next) => {
  if(err && err.type==="entity.parse.failed") return res.status(400).json({error:"Malformed JSON request."});
  if(err && err.code==="SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({error:"A record with those details already exists."});
  console.error("Request error:", err && err.message ? err.message : "unknown");
  res.status(500).json({error:"An unexpected server error occurred."});
});

const server=app.listen(PORT,()=>console.log(`MediCare Pro running at ${APP_ORIGIN} (port ${PORT})`));
function shutdown() {
  server.close(()=>{ db.close(); process.exit(0); });
  setTimeout(()=>process.exit(1),5000).unref();
}
process.on("SIGINT",shutdown);
process.on("SIGTERM",shutdown);
