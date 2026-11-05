// Usage: npm run hash-password "your password"
// Paste the printed hash into the ADMIN_PASSWORD_HASH variable. The plain password is stored nowhere.
const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash-password "your password"');
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 10));
