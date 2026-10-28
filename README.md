# MediCare Pro — Complete Hospital Management System (Portfolio Build)

A responsive full-stack hospital operations demo built with Node.js, Express, SQLite, vanilla JavaScript and custom CSS. It is designed as a substantial portfolio project, not a certified or production-ready clinical system.

## Features included

- Responsive dashboard with operational metrics and invoice totals
- Login using bcrypt password hashes and short-lived JWT in an HttpOnly cookie
- Role-based permissions: admin, doctor, nurse, receptionist, accountant
- User creation and account activation/deactivation (admin only)
- Patient create/read/update/delete, search and status filtering
- Doctor directory
- Appointment creation and status updates
- Bed inventory by ward, bed status changes and patient assignment
- Prescription documentation with doctor/admin creation guard
- Invoice creation, totals and status updates (no payment gateway)
- Admin-only audit log
- SQLite persistence, foreign keys, indexes, WAL mode
- Zod schema validation, request-size limit, rate limits, security headers, same-origin checks
- Parameterized SQL queries, generic error responses, no-store response headers
- Graceful shutdown and health endpoint
- Responsive layouts, accessible form labels, keyboard focus styles and modal Escape handling

## Requirements

- Node.js 20 or newer
- npm

## Setup

1. Extract the ZIP and open the project folder in a terminal.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env`.
4. Generate a long random JWT secret. Example:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

   Paste the output as `JWT_SECRET` in `.env`.

5. Create a strong admin password hash (12+ characters):

   ```bash
   npm run create-admin-hash -- "Your-Strong-Password-Here"
   ```

   Copy the printed bcrypt hash into `ADMIN_PASSWORD_HASH`. Set `ADMIN_USERNAME` to the username you want. Do not put the plaintext password in `.env`.

6. For local development, keep `NODE_ENV=development`, `APP_ORIGIN=http://localhost:5000` and `COOKIE_SECURE=false`.
7. Start the app:

   ```bash
   npm start
   ```

8. Open `http://localhost:5000`. Sign in using the username and password that match the hash you configured.

The first start creates the admin account and initializes the SQLite database at `./data/medicare.sqlite`. It also seeds fictional doctors and empty bed inventory. The app deliberately does not seed identifiable patient records.

### Development mode

```bash
npm run dev
```

### Health check

`GET http://localhost:5000/api/health`

## Roles

| Role | Intended access |
|---|---|
| Admin | All sections, user access, audit log, operational management |
| Doctor | Patients, appointments, doctors, prescriptions, bed read, invoice read |
| Nurse | Patients, bed updates, appointment read |
| Receptionist | Patients, appointments, bed read, invoice management |
| Accountant | Patient read and invoice management |

Permission checks are enforced on the server; hiding a navigation item is not the security boundary.

## Main API

All API requests except health/login require a valid session cookie.

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/dashboard`
- `GET|POST /api/patients`, `PUT|DELETE /api/patients/:id`
- `GET|POST /api/appointments`, `PATCH /api/appointments/:id/status`
- `GET|POST /api/doctors` (create admin only)
- `GET /api/beds`, `PATCH /api/beds/:id`
- `GET|POST /api/prescriptions`
- `GET|POST /api/invoices`, `PATCH /api/invoices/:id/status`
- `GET|POST /api/users`, `PATCH /api/users/:id/active` (admin only)
- `GET /api/audit-logs` (admin only)

## Important safety and production notes

**This project is not ready for real patient information or real hospital operations.** No source code can guarantee that it has “no shortcomings,” and this project has not undergone an independent penetration test or clinical/privacy compliance review.

Before a real deployment, a qualified team must at minimum:
- Replace the demo environment and review every endpoint and role policy
- Serve behind HTTPS and set `NODE_ENV=production`, `COOKIE_SECURE=true`, a production `APP_ORIGIN`, a strong unique `JWT_SECRET`, and carefully configured proxy trust
- Add a reviewed session revocation strategy, MFA, password reset/change, account lockout policy, and secure account recovery
- Review privacy/data-protection obligations for the deployment jurisdiction, retention, consent and breach response
- Add automated integration tests, dependency scanning, SAST/DAST, backups and tested restore procedures, monitoring and incident alerts
- Add clinical workflow validation, explicit consent and authorization, data export controls, immutable audit strategy, and data-retention/deletion policy
- Review CSP and hosting configuration, database encryption at rest, secrets management, disaster recovery and scaling strategy
- Integrate an approved payment provider if real payments are needed; this app does not process payments
- Have medical professionals validate any clinical workflows. This app provides no medical advice or medication interaction checks.

### Known limitations

- Single-server SQLite setup is intended for local/demo/small test deployments, not a multi-instance hospital production workload.
- The session token is time-limited, but an already-issued JWT is not immediately revoked when an account is disabled; use a production session store/revocation design before deployment.
- No MFA, self-service password change/reset, appointment conflict detection, prescription interaction checks, payment gateway, file uploads, lab/radiology workflows, pharmacy inventory, insurance claims or data export module.
- The UI uses English and BDT currency formatting; adapt localization, time zone and currency before use elsewhere.
- This is an educational/portfolio implementation and not a substitute for a certified Hospital Information System.

## Tech stack

- Frontend: HTML5, CSS3, vanilla JavaScript (no build step or frontend CDN dependencies)
- Backend: Node.js, Express.js
- Database: SQLite via better-sqlite3
- Security: Helmet, bcryptjs, JWT, HttpOnly/SameSite cookies, express-rate-limit, Zod
- Testing: Node.js built-in test runner (test coverage should be expanded before release)

## License

For learning and portfolio use. Review all dependencies and licensing before commercial redistribution.
