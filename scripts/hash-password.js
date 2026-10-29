const bcrypt = require("bcryptjs");
const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Usage: npm run create-admin-hash -- "A-strong-password-12+"');
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}
bcrypt.hash(password, 12).then((hash) => {
  console.log("\nCopy this value into ADMIN_PASSWORD_HASH in your .env file:\n");
  console.log(hash);
  console.log("");
});
