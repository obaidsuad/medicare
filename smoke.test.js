const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
test("project includes expected core files", () => {
  for (const file of ["server.js", "package.json", ".env.example", "public/index.html", "public/styles.css", "public/app.js"]) {
    assert.ok(fs.existsSync(path.join(root, file)), `Missing ${file}`);
  }
});
test("server has required auth, validation, and security controls", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  for (const needle of ["helmet(", "rateLimit(", "bcrypt.compare", "jwt.verify", "httpOnly", "z.object", "audit_logs", "foreign_keys = ON"]) {
    assert.ok(server.includes(needle), `Expected server control: ${needle}`);
  }
});
test("frontend avoids external CDN script dependencies", () => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  assert.ok(!/https?:\/\/(unpkg|cdn\.tailwindcss|fonts\.googleapis)/i.test(html));
});
