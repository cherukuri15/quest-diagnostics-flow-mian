// Usage: npm run hash-password -- "YourStrongPassword"
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "YourStrongPassword"');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Use at least 10 characters for the shared password.');
  process.exit(1);
}
const hash = bcrypt.hashSync(password, 12);
console.log('\nPut this line in your .env file:\n');
console.log(`APP_PASSWORD_HASH='${hash}'\n`);
