# Release checklist

This is a practical checklist, not a certification or audit report.

## Before running locally
- [ ] Use Node.js 20+
- [ ] Create `.env` from `.env.example`
- [ ] Generate a unique `JWT_SECRET` (48+ random bytes recommended)
- [ ] Generate a bcrypt admin hash; never use a real or reused password
- [ ] Keep `.env`, database and backups out of source control
- [ ] Use synthetic data only

## Before any internet-facing deployment
- [ ] Independent code review and penetration test
- [ ] HTTPS end-to-end; `NODE_ENV=production` and `COOKIE_SECURE=true`
- [ ] Correct `APP_ORIGIN`, proxy settings and network firewall
- [ ] MFA and reviewed account recovery/password reset
- [ ] Immediate session revocation for disabled users and logout-all support
- [ ] Strong role/record-level authorization review
- [ ] CSP, CSRF/origin, cookie and CORS policy review
- [ ] Encrypted backups, restore drills, retention and deletion policy
- [ ] Centralized monitoring, alerting and incident response
- [ ] Dependency audit, SAST/DAST, integration tests and load tests
- [ ] Privacy/legal review for relevant jurisdiction
- [ ] Clinical workflow review by qualified clinicians
- [ ] Production database, migration strategy and concurrency/load testing
